import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { acquireProcessLock } from "./storage.mjs";

export { azureKeyVaultEnabled } from "./signer-backend.mjs";

export class AzureKeyVault {
  constructor(vaultUrl, transport = fetch) {
    const url = new URL(vaultUrl);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.vault\.azure\.net$/.test(url.hostname) || url.port ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("Invalid Azure Key Vault URL.");
    }
    this.url = url.origin;
    this.transport = transport;
    this.token = null;
    this.pendingToken = null;
  }

  async accessToken() {
    if (this.token && this.token.expires > Date.now() + 300000) return this.token.value;
    this.pendingToken ??= (async () => {
      const response = await this.transport("http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net", {
        headers: { Metadata: "true" }, signal: AbortSignal.timeout(10000), redirect: "error",
      });
      if (!response.ok) throw new Error("Azure VM managed identity is unavailable.");
      const token = await response.json();
      if (typeof token.access_token !== "string" || !Number.isFinite(Number(token.expires_on))) throw new Error("Invalid Azure managed identity response.");
      this.token = { value: token.access_token, expires: Number(token.expires_on) * 1000 };
      return this.token.value;
    })();
    try { return await this.pendingToken; } finally { this.pendingToken = null; }
  }

  async request(path, options = {}) {
    if (!/^\/(secrets|deletedsecrets)\/[a-zA-Z0-9-]{1,127}$/.test(path)) throw new Error("Invalid Key Vault secret name.");
    const token = await this.accessToken();
    return this.transport(this.url + path + "?api-version=7.4", {
      ...options, headers: { "content-type": "application/json", Authorization: "Bearer " + token },
      redirect: "error", signal: AbortSignal.timeout(20000),
    });
  }

  async get(name) {
    const response = await this.request("/secrets/" + name);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Azure Key Vault read failed (HTTP " + response.status + ").");
    const record = await response.json();
    if (typeof record.value !== "string" || !record.value) throw new Error("Key Vault returned an empty secret.");
    return record.value;
  }

  async create(name, value) {
    // Initialization is serialized by a durable local process lock on the MVP
    // host. Multiple provisioning hosts require a distributed lease first.
    if (await this.get(name) !== null) throw new Error("Refusing to replace an existing Azure secret.");
    const deleted = await this.request("/deletedsecrets/" + name);
    if (deleted.ok) throw new Error("The Azure secret is soft-deleted. Recover its original version before continuing.");
    if (deleted.status !== 404) throw new Error("Could not verify the Azure secret's recovery state.");
    const response = await this.request("/secrets/" + name, { method: "PUT", body: JSON.stringify({ value, attributes: { enabled: true } }) });
    if (!response.ok) throw new Error("Azure Key Vault initialization failed (HTTP " + response.status + ").");
  }
}

function settings(label) {
  if (!["operator", "deployer"].includes(label)) throw new Error("Unknown Azure signer role.");
  const prefix = process.env.TERRA_AZURE_SECRET_PREFIX ?? "terra-mvp";
  if (!/^[a-zA-Z0-9-]{1,90}$/.test(prefix)) throw new Error("Invalid Azure secret prefix.");
  if (!process.env.TERRA_AZURE_VAULT_URL || !process.env.TERRA_SIGNER_PUBLIC_DIRECTORY) throw new Error("Azure signer configuration is incomplete.");
  return {
    store: new AzureKeyVault(process.env.TERRA_AZURE_VAULT_URL), name: prefix + "-" + label,
    publicPath: resolve(process.env.TERRA_SIGNER_PUBLIC_DIRECTORY, label + ".public.json"),
    directory: resolve(process.env.TERRA_SIGNER_PUBLIC_DIRECTORY),
  };
}

function accountForSecret(key) {
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Invalid Azure signer key material.");
  try { return privateKeyToAccount(key); }
  catch { throw new Error("Azure signer key validation failed."); }
}

async function existingInfo(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function loadAzureSigner(label) {
  const { store, name, publicPath } = settings(label);
  const key = await store.get(name);
  if (!key) throw new Error("Azure signer has not been initialized; existing keys must be recovered rather than replaced.");
  const account = accountForSecret(key);
  const prior = await existingInfo(publicPath);
  if (prior && prior.address.toLowerCase() !== account.address.toLowerCase()) throw new Error("Azure signer differs from its preserved public identity.");
  return account;
}

export async function createAzureSigner(label) {
  const { store, name, publicPath, directory } = settings(label);
  await mkdir(directory, { recursive: true });
  const release = await acquireProcessLock(resolve(directory, label + ".lock"));
  try {
    const prior = await existingInfo(publicPath);
    let key = await store.get(name);
    if (!key) {
      if (prior) throw new Error("The preserved Azure signer secret is missing. Recover it instead of generating another identity.");
      key = generatePrivateKey();
      await store.create(name, key);
    }
    const account = accountForSecret(key);
    if (prior && prior.address.toLowerCase() !== account.address.toLowerCase()) throw new Error("Azure signer differs from its preserved public identity.");
    if (prior) return prior;
    const info = { address: account.address, role: label, protection: "Azure Key Vault via VM managed identity", createdAt: new Date().toISOString() };
    await writeFile(publicPath, JSON.stringify(info, null, 2) + "\n", { flag: "wx" });
    return info;
  } finally { await release(); }
}
