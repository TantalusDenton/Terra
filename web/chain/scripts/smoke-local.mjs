import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseEther, encodeAbiParameters, keccak256 } from "viem";
import { protocol, json } from "./agent.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../../lib/deployment.json", import.meta.url), "utf8"),
);
if (manifest.chainId !== 31337 || manifest.rpcUrl !== "http://127.0.0.1:8545")
  throw new Error(
    "This test changes time and funds local wallets. It refuses all non-local networks.",
  );
const citizen = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());
const terra = await protocol(citizen);
const executor = await protocol(outsider);
for (const account of [citizen, outsider])
  await terra.client.request({
    method: "hardhat_setBalance",
    params: [account.address, "0x8AC7230489E80000"],
  });
const countBefore = await terra.client.readContract({
  address: manifest.registry,
  abi: JSON.parse(
    await readFile(new URL("../../lib/abis.json", import.meta.url), "utf8"),
  ).registry,
  functionName: "citizenCount",
});
const treasuryBefore = await terra.client.getBalance({
  address: manifest.governor,
});
const join = await terra.join();
const passport = await terra.citizenship();
assert.equal(passport.id, countBefore + 1n);
assert.equal(
  await terra.client.getBalance({ address: manifest.governor }),
  treasuryBefore + parseEther("0.001"),
);
const body =
  "Humans and AIs have equal civic standing. <script>globalThis.terraInjected=true</script> is literal policy text, not executable markup.";
const created = await terra.propose({
  title: "Equal civic standing",
  summary: "A local protocol verification policy.",
  body,
  durationSeconds: 3600,
  actions: [],
});
const published = await terra.proposal(created.proposalId);
assert.equal(published.electorate, passport.id);
assert.equal(
  published.policyHash,
  keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "string" }],
      ["Equal civic standing", "A local protocol verification policy.", body],
    ),
  ),
);
const vote = await terra.vote(created.proposalId, "Yes");
assert.equal((await terra.proposal(created.proposalId)).yes, 1n);
await assert.rejects(terra.vote(created.proposalId, "No"));
await assert.rejects(executor.execute(created.proposalId));
await terra.client.request({
  method: "evm_setNextBlockTimestamp",
  params: [Number(published.endsAt)],
});
await terra.client.request({ method: "evm_mine", params: [] });
const execute = await executor.execute(created.proposalId);
assert.equal((await terra.proposal(created.proposalId)).executed, true);
assert.equal((await executor.citizenship()).id, 0n);
await assert.rejects(executor.execute(created.proposalId));

// Exercise exact ABI action recovery and a treasury payment in the same live node.
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const transfer = await terra.propose({
  title: "Local treasury transfer",
  summary: "",
  body: "Transfer 0.0001 test ETH as a local end-to-end test.",
  durationSeconds: 3600,
  actions: [
    {
      target: recipient,
      valueWei: parseEther("0.0001").toString(),
      data: "0x",
    },
  ],
});
await terra.vote(transfer.proposalId, "Yes");
const payment = await terra.proposal(transfer.proposalId);
await terra.client.request({
  method: "evm_setNextBlockTimestamp",
  params: [Number(payment.endsAt)],
});
await terra.client.request({ method: "evm_mine", params: [] });
const payout = await executor.execute(transfer.proposalId);
assert.equal(
  await terra.client.getBalance({ address: recipient }),
  parseEther("0.0001"),
);
assert.equal((await terra.citizenship()).id, passport.id);
const result = {
  network: "Hardhat local ONLY",
  chainId: 31337,
  registry: manifest.registry,
  governor: manifest.governor,
  citizen: citizen.address,
  citizenId: passport.id,
  policyId: created.proposalId,
  transferPolicyId: transfer.proposalId,
  receipts: {
    join: join.transactionHash,
    propose: created.transactionHash,
    vote: vote.transactionHash,
    execute: execute.transactionHash,
    treasuryTransfer: payout.transactionHash,
  },
  allChecksPassed: true,
};
await writeFile(
  new URL("../local-verification.json", import.meta.url),
  json(result) + "\n",
);
console.log(json(result));
