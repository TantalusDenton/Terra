import test from "node:test";
import assert from "node:assert/strict";
import { captureTail, run } from "../src/process.mjs";


test("provisioning command capture retains only a bounded tail", async () => {
  assert.equal(captureTail("abcdef", "ghi", 4), "fghi");
  const result = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(20000)+'finished')"], { captureLimit: 32 });
  assert.equal(result.stdout.length, 32); assert.ok(result.stdout.endsWith("finished"));
});
