import test from "node:test";
import assert from "node:assert/strict";
import { assertSameDockerEngine, freezeRootTemplate, frozenGenesisTimestamp } from "../src/genesis.mjs";

test("root retries preserve the archived genesis timestamp, not the wall clock", () => {
  assert.equal(frozenGenesisTimestamp(undefined, null, 1000000), 1060);
  assert.equal(frozenGenesisTimestamp({ genesisTimestamp: 1060 }, null, 99999999999), 1060);
  assert.equal(frozenGenesisTimestamp({}, { timestamp: "0x424" }, 99999999999), 1060);
  assert.throws(() => frozenGenesisTimestamp({ genesisTimestamp: 1061 }, { timestamp: "1060" }), /differ/);
  assert.throws(() => frozenGenesisTimestamp({}, null), /no frozen/);
  assert.throws(() => frozenGenesisTimestamp({ genesisTimestamp: -1 }, null), /Invalid/);
});

test("root templates reject ambiguous or previously modified genesis inputs", () => {
  const input = "ethereum_package:\n  network_params:\n    genesis_delay: 15\n";
  assert.match(freezeRootTemplate(input, 1060), /genesis_timestamp: 1060/);
  assert.throws(() => freezeRootTemplate(input + "    genesis_delay: 20\n", 1060), /exactly one/);
  assert.throws(() => freezeRootTemplate(input + "    genesis_timestamp: 99\n", 1060), /unmodified/);
});

test("WSL cannot silently select a different Docker engine and replacement ledger", () => {
  assert.doesNotThrow(() => assertSameDockerEngine("original\n", "original\r\n"));
  assert.throws(() => assertSameDockerEngine("original", "another"), /different Docker engines/);
  assert.throws(() => assertSameDockerEngine("", ""), /different Docker engines/);
});
