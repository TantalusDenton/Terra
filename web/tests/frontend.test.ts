import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { validateDraft, emptyDraft, policyBytes } from "../lib/proposals";
import { policyState, userError } from "../lib/terra";

const valid = () => ({
  ...emptyDraft(),
  title: "Equal rights",
  body: "Every registered citizen has equal rights.",
});
describe("Proposal authoring validation", () => {
  it("preserves HTML-like text literally without editorial filtering", () => {
    const draft = { ...valid(), body: '<script>alert("policy")</script>' };
    assert.equal(validateDraft(draft).body, draft.body);
    const escaped = renderToStaticMarkup(
      createElement("p", null, validateDraft(draft).body),
    );
    assert.match(escaped, /&lt;script&gt;/);
    assert.equal(escaped.includes("<script>"), false);
  });
  it("accepts both inclusive duration boundaries and fractional hours", () => {
    assert.equal(
      validateDraft({ ...valid(), duration: "1", unit: "hours" }).duration,
      3600n,
    );
    assert.equal(
      validateDraft({ ...valid(), duration: "30", unit: "days" }).duration,
      2592000n,
    );
    assert.equal(
      validateDraft({ ...valid(), duration: "1.5" }).duration,
      5400n,
    );
  });
  it("rejects out-of-range, invalid-unit, exponential and fractional-second durations", () => {
    for (const change of [
      { duration: "0" },
      { duration: "31", unit: "days" },
      { duration: "1", unit: "seconds" },
      { duration: "1e3" },
      { duration: "1.00001" },
    ])
      assert.throws(() => validateDraft({ ...valid(), ...change } as never));
  });
  it("counts UTF-8 rather than characters and enforces 16 KiB", () => {
    const draft = {
      ...valid(),
      title: "T",
      summary: "",
      body: "é".repeat(8191) + "a",
    };
    assert.equal(policyBytes(draft), 16384);
    validateDraft(draft);
    assert.throws(() => validateDraft({ ...draft, body: draft.body + "a" }));
  });
  it("parses exact ETH values and raw calldata", () => {
    const action = {
      target: "0x1111111111111111111111111111111111111111",
      value: "0.001",
      data: "0xaabb",
    };
    assert.equal(
      validateDraft({ ...valid(), actions: [action] }).actions[0].value,
      1000000000000000n,
    );
    assert.equal(
      validateDraft({
        ...valid(),
        actions: Array.from({ length: 8 }, () => action),
      }).actions.length,
      8,
    );
    assert.throws(() =>
      validateDraft({
        ...valid(),
        actions: Array.from({ length: 9 }, () => action),
      }),
    );
    for (const change of [
      { target: "0x0000000000000000000000000000000000000000" },
      { value: "-1" },
      { value: "0.0000000000000000001" },
      { value: (2n ** 256n).toString() },
      { data: "0xa" },
      { data: "alert()" },
    ])
      assert.throws(() =>
        validateDraft({ ...valid(), actions: [{ ...action, ...change }] }),
      );
  });
  it("rejects malformed agent inputs without coercion", () => {
    assert.throws(() => validateDraft(null as never));
    assert.throws(() =>
      validateDraft({ ...valid(), actions: [null] } as never),
    );
    assert.throws(() => validateDraft({ ...valid(), body: "" }));
  });
});
describe("Ledger-facing interface state", () => {
  const policy = {
    proposer: "0x1111111111111111111111111111111111111111",
    startsAt: 1n,
    endsAt: 3601n,
    electorate: 1n,
    policyHash: "0x",
    actionsHash: "0x",
    yes: 0n,
    no: 0n,
    abstain: 0n,
    executed: false,
  } as const;
  it("matches Active/Passed/Rejected/Enacted at the exact deadline", () => {
    assert.equal(policyState(policy, 3600), "Active");
    assert.equal(policyState(policy, 3601), "Rejected");
    assert.equal(policyState({ ...policy, yes: 1n }, 3601), "Passed");
    assert.equal(policyState({ ...policy, yes: 1n, no: 1n }, 3601), "Rejected");
    assert.equal(policyState({ ...policy, abstain: 1n }, 3601), "Rejected");
    assert.equal(policyState({ ...policy, executed: true }, 3601), "Enacted");
  });
  it("explains expected wallet, RPC, and contract failures", () => {
    assert.match(
      userError(new Error("User rejected request (4001)")),
      /declined/,
    );
    assert.match(userError(new Error("insufficient funds")), /test ETH/);
    assert.match(userError(new Error("PayloadMismatch")), /original proposal/);
    assert.match(
      userError(new Error("ActionFailed")),
      /No actions were applied/,
    );
    assert.match(
      userError(new Error("fetch timeout")),
      /connection is unavailable/,
    );
  });
});
