import test from "node:test";
import assert from "node:assert/strict";
import { assertArchivedMinimalDeneb, minimalDenebBodyRoot } from "../src/consensus-genesis.mjs";

const archived = { slot: "0", latest_block_header: { body_root: "0x8d7ab9dd0b24f639527634d2d55c6d8416bc5f4195ef8fbb9b42d9cc5fda7a1e" } };
test("preserved minimal Deneb genesis matches Lighthouse v7's 32-element blob-list bound", () => {
  assert.equal(minimalDenebBodyRoot(32), archived.latest_block_header.body_root);
  assert.equal(assertArchivedMinimalDeneb(archived, 32), archived.latest_block_header.body_root);
  const raw = Buffer.alloc(176);
  Buffer.from(archived.latest_block_header.body_root.slice(2), "hex").copy(raw, 144);
  assert.equal(assertArchivedMinimalDeneb(archived, 32, raw), archived.latest_block_header.body_root);
  raw[144] ^= 1;
  assert.throws(() => assertArchivedMinimalDeneb(archived, 32, raw), /preserved SSZ/);
});
test("a client-preset upgrade fails before network startup instead of replacing genesis", () => {
  assert.equal(minimalDenebBodyRoot(4096), "0x9a93f48c8b8c444cc74b5ce82ea6354d15f4e9a4c254c5478cfde6ac19edaba9");
  assert.throws(() => assertArchivedMinimalDeneb(archived, 4096), /incompatible/);
  assert.throws(() => assertArchivedMinimalDeneb({ ...archived, slot: "1" }, 32), /slot zero/);
  assert.throws(() => minimalDenebBodyRoot(33), /Unsupported/);
});
