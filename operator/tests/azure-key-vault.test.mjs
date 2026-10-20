import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AzureKeyVault, createAzureSigner, loadAzureSigner } from "../src/azure-key-vault.mjs";

const token = () => Response.json({ access_token: "fixture-token", expires_on: String(Math.floor(Date.now() / 1000) + 3600) });

test("vault credentials cannot be redirected to an arbitrary endpoint", () => {
  for (const url of ["http://test.vault.azure.net", "https://example.com", "https://test.vault.azure.net/other", "https://test.vault.azure.net?token=x"]) {
    assert.throws(() => new AzureKeyVault(url), /Invalid Azure Key Vault URL/);
  }
});

test("a vault permission failure is not treated as a missing key", async () => {
  const methods = [];
  const store = new AzureKeyVault("https://fixture.vault.azure.net", async (url, options) => {
    if (url.startsWith("http://169.254.169.254/")) return token();
    methods.push(options.method ?? "GET");
    return new Response(null, { status: 403 });
  });
  await assert.rejects(store.create("terra-operator", "fixture-value"), /HTTP 403/);
  assert.deepEqual(methods, ["GET"]);
});

test("soft-deleted or existing secrets are preserved during initialization", async () => {
  for (const existing of [true, false]) {
    const methods = [];
    const store = new AzureKeyVault("https://fixture.vault.azure.net", async (url, options) => {
      if (url.startsWith("http://169.254.169.254/")) return token();
      methods.push(options.method ?? "GET");
      if (url.includes("/deletedsecrets/")) return Response.json({ recoveryId: "fixture" });
      return existing ? Response.json({ value: "fixture-existing" }) : new Response(null, { status: 404 });
    });
    await assert.rejects(store.create("terra-operator", "fixture-new"), /Refusing to replace|soft-deleted/);
    assert.equal(methods.includes("PUT"), false);
  }
});

test("managed identity tokens are shared by concurrent vault reads", async () => {
  let requests = 0;
  const store = new AzureKeyVault("https://fixture.vault.azure.net", async (url, options) => {
    if (url.startsWith("http://169.254.169.254/")) { requests++; return token(); }
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    return Response.json({ value: "fixture-value" });
  });
  assert.deepEqual(await Promise.all([store.get("terra-operator"), store.get("terra-deployer")]), ["fixture-value", "fixture-value"]);
  assert.equal(requests, 1);
});

test("a missing secret with a preserved wallet identity cannot generate a replacement key", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "terra-azure-signer-"));
  const originalFetch = globalThis.fetch;
  const names = ["TERRA_AZURE_VAULT_URL", "TERRA_SIGNER_PUBLIC_DIRECTORY"];
  const previous = names.map(name => process.env[name]);
  try {
    process.env.TERRA_AZURE_VAULT_URL = "https://fixture.vault.azure.net";
    process.env.TERRA_SIGNER_PUBLIC_DIRECTORY = directory;
    await writeFile(resolve(directory, "operator.public.json"), JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }));
    globalThis.fetch = async (url, options) => {
      if (url.startsWith("http://169.254.169.254/")) return token();
      assert.notEqual(options.method, "PUT");
      return new Response(null, { status: 404 });
    };
    await assert.rejects(createAzureSigner("operator"), /Recover it instead of generating/);
    globalThis.fetch = async url => url.startsWith("http://169.254.169.254/")
      ? token() : Response.json({ value: "0x" + "ff".repeat(32) });
    await assert.rejects(loadAzureSigner("operator"), { message: "Azure signer key validation failed." });
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(directory, { recursive: true, force: true });
  }
});
