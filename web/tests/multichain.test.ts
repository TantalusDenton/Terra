import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { encodeAbiParameters, encodeFunctionResult, keccak256, type Hex } from "viem";
import templates from "../lib/verification-templates.json";
import { communityChain, communityPath, decodeProposal, matchesRuntime, protocolAbis, rootCommunity, verifyPayload, verifyProposalOnchain, type Community } from "../lib/community";

const registry = "0x0000000000000000000000000000000000000011" as const;
const governor = "0x0000000000000000000000000000000000000022" as const;
const corporation: Community = { ...rootCommunity, id: "9007199254740993", kind: "blockshares", name: "Equal Minds", chainId: "5210001", registry, governor };
function proposal(body = "Permanent equal standing.") {
  const title = "A resolution"; const summary = "All stockholders are equal.";
  const policyHash = keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "string" }], [title, summary, body]));
  const actionsHash = keccak256(encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], [[]]));
  return decodeProposal({ id: "9007199254740993", title, summary, body, proposer: registry, startsAt: "100", endsAt: "3700", electorate: "10000000001", yes: "9007199254740999", no: "0", abstain: "0", policyHash, actionsHash, executed: false, actions: [], creationTx: ("0x" + "aa".repeat(32)) as Hex });
}
describe("Multichain browser invariants", () => {
  it("preserves large identifiers and quantities without number rounding", () => {
    const value = proposal(); assert.equal(value.id, 9007199254740993n); assert.equal(value.yes, 9007199254740999n); assert.equal(value.electorate, 10000000001n);
  });
  it("keeps Terra URLs and scopes corporate URLs to their request", () => {
    assert.equal(communityPath(rootCommunity, "/proposals/7"), "/proposals/7");
    assert.equal(communityPath(corporation, "/proposals/7"), "/blockshares/9007199254740993/proposals/7");
  });
  it("can display rejected oversized pending chain identifiers without rounding or enabling a network", () => {
    const pending = { ...corporation, status: "Failed", chainId: "9007199254740993" };
    const chain = communityChain(pending); assert.match(chain.name, /unsupported/);
    assert.equal(chain.rpcUrls.default.http[0], "http://127.0.0.1:1"); assert.equal(pending.chainId, "9007199254740993");
    assert.throws(() => communityChain({ ...pending, status: "Active" }), /supported range/);
  });
  it("rejects policy or execution-payload substitution", () => {
    const value = proposal(); verifyPayload(value);
    assert.throws(() => verifyPayload({ ...value, body: "Changed policy" }), /commitments/);
    assert.throws(() => verifyPayload({ ...value, actions: [{ target: governor, value: 1n, data: "0x" }] }), /commitments/);
  });
  it("lazy cards do not require full policy content or action arrays", () => {
    const value = proposal(); const card = decodeProposal({ ...value, id: value.id.toString(), body: undefined, actions: undefined, actionCount: 8 });
    assert.equal(card.body, ""); assert.deepEqual(card.actions, []); assert.equal(card.actionCount, 8);
  });
  for (const [name, template] of Object.entries(templates.contracts)) {
    it("binds the tested " + name + " runtime to its exact counterpart", () => {
      let code = template.deployedBytecode.slice(2);
      for (const refs of Object.values(template.immutableReferences)) for (const ref of refs) code = code.slice(0, ref.start * 2) + registry.slice(2).padStart(ref.length * 2, "0") + code.slice((ref.start + ref.length) * 2);
      assert.equal(matchesRuntime(("0x" + code) as Hex, template, registry), true);
      assert.equal(matchesRuntime(("0x" + code) as Hex, template, governor), false);
      assert.equal(matchesRuntime(("0x00" + code.slice(2)) as Hex, template, registry), false);
    });
  }
  it("checks fresh onchain commitments even when substituted index text is internally consistent", async () => {
    const original = proposal(); let calls = 0;
    const result = encodeFunctionResult({ abi: protocolAbis.blocksharesGovernor, functionName: "getProposal", result: original });
    const server = createServer(async (request, response) => {
      let buffer = ""; for await (const chunk of request) buffer += chunk;
      const input = JSON.parse(buffer); assert.equal(input.method, "eth_call"); calls++;
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number }; const selected = { ...corporation, rpcUrl: "http://127.0.0.1:" + address.port };
      await verifyProposalOnchain(selected, original);
      const substituted = proposal("Treasury spending added by an untrusted index."); verifyPayload(substituted);
      await assert.rejects(verifyProposalOnchain(selected, substituted), /authoritative blockchain/);
      assert.equal(calls, 2);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
