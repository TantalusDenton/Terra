import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { prepareClientConfig } from "../scripts/prepare-client-config.mjs";

test("a fresh checkout gets undeployed defaults with no trusted governor or rollup", async () => {
  const webRoot = await mkdtemp(resolve(tmpdir(), "terra-client-config-"));
  try {
    assert.deepEqual(await prepareClientConfig({ webRoot }), ["lib/deployment.json", "lib/rollup-anchor.json", ".openai/hosting.json"]);
    const deployment = JSON.parse(await readFile(resolve(webRoot, "lib/deployment.json"), "utf8"));
    const anchor = JSON.parse(await readFile(resolve(webRoot, "lib/rollup-anchor.json"), "utf8"));
    const hosting = JSON.parse(await readFile(resolve(webRoot, ".openai/hosting.json"), "utf8"));
    assert.equal(deployment.status, "undeployed");
    assert.equal(deployment.governor, "");
    assert.equal(deployment.registry, "");
    assert.equal(anchor.terra, null);
    assert.equal(hosting.project_id, null);
    assert.equal(hosting.d1, null);
    assert.equal(hosting.r2, null);
    assert.deepEqual(await prepareClientConfig({ webRoot }), []);
  } finally { await rm(webRoot, { recursive: true, force: true }); }
});

test("app preparation preserves deployment state and root trust anchors byte for byte", async () => {
  const webRoot = await mkdtemp(resolve(tmpdir(), "terra-client-config-"));
  try {
    await mkdir(resolve(webRoot, "lib"));
    await mkdir(resolve(webRoot, ".openai"));
    const deployment = '{ "status": "deployed", "preserved": true }\n';
    const anchor = '{ "version": 1, "terra": { "preserved": true } }\n';
    const hosting = '{ "project_id": "fixture-site", "d1": null, "r2": null }\n';
    await writeFile(resolve(webRoot, "lib/deployment.json"), deployment);
    await writeFile(resolve(webRoot, "lib/rollup-anchor.json"), anchor);
    await writeFile(resolve(webRoot, ".openai/hosting.json"), hosting);
    assert.deepEqual(await prepareClientConfig({ webRoot }), []);
    assert.equal(await readFile(resolve(webRoot, "lib/deployment.json"), "utf8"), deployment);
    assert.equal(await readFile(resolve(webRoot, "lib/rollup-anchor.json"), "utf8"), anchor);
    assert.equal(await readFile(resolve(webRoot, ".openai/hosting.json"), "utf8"), hosting);
  } finally { await rm(webRoot, { recursive: true, force: true }); }
});
