// HTTP service/API checks only, not a substitute for browser or wallet-interaction QA.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const origin = "http://127.0.0.1:5185";
const manifest = JSON.parse(
  await readFile(new URL("../lib/deployment.json", import.meta.url), "utf8"),
);
const results = [];
for (const [path, expected] of [
  ["/", 200],
  ["/charter", 200],
  ["/citizenship", 200],
  ["/proposals/new", 200],
  ["/proposals/1", 200],
  ["/proposals/invalid", 404],
]) {
  const response = await fetch(origin + path, {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(
    response.status,
    expected,
    `Server route ${path} returned ${response.status}, not ${expected}`,
  );
  await response.body?.cancel();
  results.push({ path, status: response.status });
}
const response = await fetch(origin + "/protocol", {
  signal: AbortSignal.timeout(30000),
});
assert.equal(response.status, 200);
const protocol = await response.json();
assert.equal(protocol.protocol, "Terra");
assert.deepEqual(protocol.deployment, manifest);
assert.ok(
  protocol.interfaces.registry.some(
    (item) => item.type === "function" && item.name === "join",
  ),
);
assert.ok(
  protocol.interfaces.governor.some(
    (item) => item.type === "function" && item.name === "vote",
  ),
);
console.log(
  JSON.stringify(
    {
      routes: results,
      protocolExportMatchesManifest: true,
      browserChecks: "not performed",
    },
    null,
    2,
  ),
);
