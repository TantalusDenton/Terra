import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobStore, advanceJob } from "../src/jobs.mjs";

test("crash recovery resumes original job and never re-provisions its committed network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terra-operator-test-"));
  try {
    const store = new JobStore(join(directory, "jobs.json"));
    const job = await store.enqueue({ id: "9007199254740993", chainId: "2151909", metadataHash: "0xabc" }, { blockHash: "0xbeef" });
    let networks = 0;
    await assert.rejects(advanceJob(store, job, { network: async () => { networks++; return { enclave: "original" }; }, governance: async () => { throw new Error("crashed after durable network checkpoint"); } }));
    const recovered = (await new JobStore(store.path).load()).jobs[job.id];
    assert.equal(recovered.step, "governance");
    assert.equal(recovered.status, "Failed");
    assert.equal(recovered.attempts, 1);
    assert.match(recovered.error, /crashed/);
    assert.ok(Date.parse(recovered.retryAfter) > Date.now());
    assert.equal(recovered.enclave, "original");
    await advanceJob(store, recovered, { governance: async () => ({}), verify: async () => ({}), activate: async () => ({ activation: "0x123" }), publish: async () => ({}) });
    assert.equal(networks, 1);
    assert.equal((await store.load()).jobs[job.id].status, "Active");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("metadata and chain-ID collisions fail before infrastructure mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terra-operator-test-"));
  try {
    const store = new JobStore(join(directory, "jobs.json"));
    await store.enqueue({ id: "1", chainId: "2151909", metadataHash: "0xabc" }, {});
    await assert.rejects(store.enqueue({ id: "1", chainId: "2151909", metadataHash: "0xdef" }, {}), /changed/);
    await assert.rejects(store.enqueue({ id: "2", chainId: "2151909", metadataHash: "0xdef" }, {}), /claims/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
