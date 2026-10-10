import { createHash } from "node:crypto";

const zero = Buffer.alloc(32);
const pair = (left, right) => createHash("sha256").update(left).update(right).digest();
function zeroTree(depth) {
  let root = zero;
  for (let index = 0; index < depth; index++) root = pair(root, root);
  return root;
}
function container(fields) {
  let width = 1;
  while (width < fields.length) width *= 2;
  let layer = [...fields, ...Array(width - fields.length).fill(zero)];
  while (layer.length > 1) {
    const next = [];
    for (let index = 0; index < layer.length; index += 2) next.push(pair(layer[index], layer[index + 1]));
    layer = next;
  }
  return layer[0];
}
const emptyList = depth => pair(zeroTree(depth), zero);

// Narrow compatibility diagnostic, not a general SSZ decoder or remote-chain
// correctness proof. This models the all-zero empty Deneb block body used by
// Lighthouse's EmptyBlock implementation and the genesis generator.
export function minimalDenebBodyRoot(blobCommitmentLimit) {
  if (![16, 32, 4096].includes(blobCommitmentLimit)) throw new Error("Unsupported diagnostic blob-list bound.");
  const payload = container([
    zero, zero, zero, zero, zeroTree(3), zero, zero, zero, zero, zero,
    emptyList(0), zero, zero, emptyList(20), emptyList(2), zero, zero,
  ]);
  return `0x${container([
    zeroTree(2), zeroTree(2), zero, emptyList(4), emptyList(1), emptyList(7),
    emptyList(4), emptyList(4), container([zero, zeroTree(2)]), payload,
    emptyList(4), emptyList(Math.log2(blobCommitmentLimit)),
  ]).toString("hex")}`;
}

export function assertArchivedMinimalDeneb(parsed, blobCommitmentLimit, raw) {
  if (String(parsed.slot) !== "0") throw new Error("Archived consensus genesis is not at slot zero.");
  // Deneb BeaconState's fixed prefix places slot at byte 40 and the latest
  // block header's body root at byte 144. Bind the parsed diagnostic to the
  // retained bytes; this still does not validate the complete genesis state.
  if (raw && (raw.length < 176 || raw.readBigUInt64LE(40) !== 0n || `0x${raw.subarray(144, 176).toString("hex")}` !== parsed.latest_block_header?.body_root?.toLowerCase())) {
    throw new Error("Parsed consensus header differs from the preserved SSZ genesis bytes.");
  }
  const expected = minimalDenebBodyRoot(blobCommitmentLimit);
  if (parsed.latest_block_header?.body_root?.toLowerCase() !== expected) {
    throw new Error(`Archived Deneb body root is incompatible with the ${blobCommitmentLimit}-element client preset. Genesis has not been changed.`);
  }
  return expected;
}
