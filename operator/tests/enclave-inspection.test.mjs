import test from "node:test";
import assert from "node:assert/strict";
import { assertLogsCollectorReady, parseEnclaveInspection } from "../src/enclave-inspection.mjs";

test("an inspect outage or stale service is not a missing enclave", () => {
  assert.throws(() => parseEnclaveInspection("terra-settlement", {
    code: 1, stdout: "Name: terra-settlement\nFiles Artifacts", stderr: "couldn't find service in backend",
  }), /Cannot safely inspect.*No ledger was reset.*couldn't find service/s);
});

test("inspect parses only UUID table rows and preserves artifact identity", () => {
  const result = parseEnclaveInspection("terra-settlement", { code: 0, stderr: "", stdout:
    "UUID: 1a4fa302c106\nFiles Artifacts ===\nUUID Name\n5f2468cb874b4038b12e3f0d717d6408 el_cl_genesis_data\n=== User Services ===\nUUID Name Ports Status\n544537d8a093 validator-key-generation-cl-validator-keystore <none> STOPPED\n" });
  assert.equal(result.uuidPrefix, "1a4fa302c106");
  assert.deepEqual(result.artifacts, ["el_cl_genesis_data"]);
  assert.deepEqual(result.services, ["validator-key-generation-cl-validator-keystore"]);
});

test("a stopped, ambiguous, or foreign logs collector blocks retries before service mutation", () => {
  const original = "1a4fa302c1064ce1b8b27fa69e3272f8";
  assert.doesNotThrow(() => assertLogsCollectorReady(original.slice(0, 12), { code: 0, stdout: `${original}\n` }));
  for (const stdout of ["", `${original}\n${original}\n`, "0".repeat(32)]) {
    assert.throws(() => assertLogsCollectorReady(original.slice(0, 12), { code: 0, stdout }), /not confirmed running/);
  }
  assert.throws(() => assertLogsCollectorReady(undefined, { code: 0, stdout: original }), /identity/);
  assert.throws(() => assertLogsCollectorReady(original, { code: 1, stdout: original }), /not confirmed running/);
});
