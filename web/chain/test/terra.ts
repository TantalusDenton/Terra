import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, parseEther, zeroAddress } from "viem";

const BOND = parseEther("0.001");
type Action = { target: `0x${string}`; value: bigint; data: `0x${string}` };

for (const variant of [
  { governor: "TerraGovernor", registry: "CitizenRegistry" },
  { governor: "BlocksharesGovernor", registry: "StockholderRegistry" },
] as const) describe(`${variant.governor} constitutional protocol`, () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  async function setup() {
    const connection = await network.create("hardhat");
    const { viem, networkHelpers } = connection;
    const wallets = await viem.getWalletClients();
    const client = await viem.getPublicClient();
    const governor = await viem.deployContract(variant.governor);
    const registry = await viem.getContractAt(
      variant.registry,
      await governor.read.registry(),
    );
    return {
      connection,
      viem,
      networkHelpers,
      wallets,
      client,
      governor,
      registry,
    };
  }
  beforeEach(async () => {
    ctx = await setup();
  });
  async function join(index = 0, value = BOND) {
    const hash = await ctx.registry.write.join([], {
      account: ctx.wallets[index].account,
      value,
    });
    return ctx.client.waitForTransactionReceipt({ hash });
  }
  async function propose(actions: Action[] = [], duration = 3600n) {
    await ctx.governor.write.propose(
      [
        "Common policy",
        "Equal civic participation",
        "A public policy for all citizens.",
        duration,
        actions,
      ],
      { account: ctx.wallets[0].account },
    );
    return ctx.governor.read.proposalCount();
  }
  async function vote(id: bigint, choice: number, voter = 0) {
    return ctx.governor.write.vote([id, choice], {
      account: ctx.wallets[voter].account,
    });
  }
  async function close(id: bigint) {
    const p = await ctx.governor.read.getProposal([id]);
    await ctx.networkHelpers.time.increaseTo(p.endsAt);
  }
  async function execute(id: bigint, actions: Action[] = [], executor = 5) {
    return ctx.governor.write.execute([id, actions], {
      account: ctx.wallets[executor].account,
    });
  }

  it("issues one permanent passport and forwards the exact contribution", async () => {
    const receipt = await join();
    const [id, joinedAt, joinedBlock] = await ctx.registry.read.citizens([
      ctx.wallets[0].account.address,
    ]);
    assert.equal(id, 1n);
    assert(joinedAt > 0n);
    assert.equal(joinedBlock, receipt.blockNumber);
    assert.equal(await ctx.registry.read.citizenCount(), 1n);
    assert.equal(
      await ctx.client.getBalance({ address: ctx.registry.address }),
      0n,
    );
    assert.equal(
      await ctx.client.getBalance({ address: ctx.governor.address }),
      BOND,
    );
    assert.equal(
      await ctx.registry.read.isCitizen([ctx.wallets[0].account.address]),
      true,
    );
  });
  it("rejects underpayment, overpayment, and repeat citizenship", async () => {
    await assert.rejects(join(0, BOND - 1n), /IncorrectContribution/);
    await assert.rejects(join(0, BOND + 1n), /IncorrectContribution/);
    assert.equal(await ctx.registry.read.citizenCount(), 0n);
    await join();
    await assert.rejects(join(), /AlreadyCitizen/);
    assert.equal(await ctx.registry.read.citizenCount(), 1n);
  });
  it("rolls enrollment back when the treasury rejects payment", async () => {
    const treasury = await ctx.viem.deployContract("RejectingTreasury");
    const registry = await ctx.viem.deployContract(variant.registry, [
      treasury.address,
    ]);
    await assert.rejects(
      registry.write.join([], { value: BOND }),
      /TreasuryTransferFailed/,
    );
    assert.equal(await registry.read.citizenCount(), 0n);
    assert.equal(
      await registry.read.isCitizen([ctx.wallets[0].account.address]),
      false,
    );
  });
  it("gives two independently controlled actors identical permissions and weight", async () => {
    await join(0);
    await join(1);
    const first = await propose();
    await ctx.governor.write.propose(
      ["Another policy", "", "Equal proposal rights", 3600n, []],
      { account: ctx.wallets[1].account },
    );
    await vote(first, 1, 0);
    await vote(first, 1, 1);
    const p = await ctx.governor.read.getProposal([first]);
    assert.equal(p.yes, 2n);
    const votes = await ctx.governor.getEvents.VoteCast(
      { proposalId: first },
      { fromBlock: 0n },
    );
    assert.equal(votes.length, 2);
    for (const event of votes) assert.equal(event.args.weight, 1n);
  });
  it("rejects noncitizen proposals and ballots", async () => {
    await assert.rejects(propose(), /NotCitizen/);
    await join();
    const id = await propose();
    await assert.rejects(vote(id, 1, 1), /NotCitizen/);
  });
  it("fixes the electorate and rejects a citizen admitted during a vote", async () => {
    await join();
    const id = await propose();
    await join(1);
    assert.equal((await ctx.governor.read.getProposal([id])).electorate, 1n);
    await assert.rejects(vote(id, 1, 1), /NotInElectorate/);
    const next = await propose();
    await vote(next, 1, 1);
    assert.equal((await ctx.governor.read.getProposal([next])).yes, 1n);
  });
  it("preserves IDs, snapshots, and constant-work participation above one billion and 2^53", async () => {
    // Simulate an already populated registry; this tests integer handling, not throughput.
    // ReentrancyGuard uses namespaced storage, making citizenCount the registry's slot zero.
    const count = 9007199254740993n;
    await ctx.networkHelpers.setStorageAt(ctx.registry.address, 0n, count);
    assert.equal(await ctx.registry.read.citizenCount(), count);
    await join();
    const [id] = await ctx.registry.read.citizens([ctx.wallets[0].account.address]);
    assert.equal(id, count + 1n);
    const policy = await propose();
    assert.equal((await ctx.governor.read.getProposal([policy])).electorate, count + 1n);
    await join(1);
    await assert.rejects(vote(policy, 1, 1), /NotInElectorate/);
    await vote(policy, 1);
    await close(policy);
    await execute(policy);
    assert.equal((await ctx.governor.read.getProposal([policy])).yes, 1n);
  });
  it("rejects second ballots and invalid choices", async () => {
    await join();
    const id = await propose();
    await assert.rejects(vote(id, 3), /InvalidChoice/);
    await vote(id, 0);
    await assert.rejects(vote(id, 1), /AlreadyVoted/);
    assert.equal(
      await ctx.governor.read.ballots([id, ctx.wallets[0].account.address]),
      1,
    );
  });
  it("enforces both duration bounds, accepting the inclusive endpoints", async () => {
    await join();
    await assert.rejects(propose([], 3599n), /InvalidDuration/);
    await assert.rejects(propose([], 2592001n), /InvalidDuration/);
    await propose([], 3600n);
    await propose([], 2592000n);
    assert.equal(await ctx.governor.read.proposalCount(), 2n);
  });
  it("enforces the policy byte limit and eight-action limit", async () => {
    await join();
    await assert.rejects(
      ctx.governor.write.propose(["", "", "Text", 3600n, []]),
      /InvalidPolicy/,
    );
    await assert.rejects(
      ctx.governor.write.propose(["A", "", "é".repeat(8192), 3600n, []]),
      /InvalidPolicy/,
    );
    await ctx.governor.write.propose(["A", "", "a".repeat(16383), 3600n, []]);
    const action: Action = {
      target: ctx.wallets[2].account.address,
      value: 0n,
      data: "0x",
    };
    await assert.rejects(propose(Array(9).fill(action)), /TooManyActions/);
    await propose(Array(8).fill(action));
    await assert.rejects(
      propose([{ ...action, target: zeroAddress }]),
      /InvalidTarget/,
    );
  });
  it("rejects unknown proposals", async () => {
    await assert.rejects(ctx.governor.read.state([0n]), /UnknownProposal/);
    await assert.rejects(vote(2n, 1), /UnknownProposal/);
    await assert.rejects(execute(1n), /UnknownProposal/);
  });
  it("requires the deadline, but no quorum or execution delay", async () => {
    for (let i = 0; i < 6; i++) await join(i);
    const id = await propose();
    await vote(id, 1);
    await assert.rejects(execute(id), /NotPassed/);
    await close(id);
    assert.equal(await ctx.governor.read.state([id]), 2);
    await assert.rejects(vote(id, 1, 1), /VotingClosed/);
    await execute(id, [], 7); // A noncitizen can execute.
    assert.equal(await ctx.governor.read.state([id]), 3);
    const events = await ctx.governor.getEvents.PolicyEnacted({
      proposalId: id,
    });
    assert.equal(events.length, 1);
    assert.equal(
      events[0].args.policyHash,
      (await ctx.governor.read.getProposal([id])).policyHash,
    );
    await assert.rejects(execute(id), /AlreadyExecuted/);
  });
  it("rejects zero-vote and abstention-only policies", async () => {
    await join();
    const empty = await propose();
    const abstain = await propose();
    await vote(abstain, 2);
    await close(abstain);
    assert.equal(await ctx.governor.read.state([empty]), 1);
    assert.equal(await ctx.governor.read.state([abstain]), 1);
    await assert.rejects(execute(empty), /NotPassed/);
    await assert.rejects(execute(abstain), /NotPassed/);
  });
  it("rejects ties and No majorities", async () => {
    await join();
    await join(1);
    await join(2);
    const tie = await propose();
    const no = await propose();
    await vote(tie, 1, 0);
    await vote(tie, 0, 1);
    await vote(no, 0, 0);
    await vote(no, 0, 1);
    await vote(no, 1, 2);
    await close(no);
    assert.equal(await ctx.governor.read.state([tie]), 1);
    assert.equal(await ctx.governor.read.state([no]), 1);
  });
  it("executes immutable arbitrary contract calls and treasury transfers", async () => {
    await join();
    const target = await ctx.viem.deployContract("TestTarget");
    const actions: Action[] = [
      {
        target: target.address,
        value: BOND / 2n,
        data: encodeFunctionData({
          abi: target.abi,
          functionName: "setValue",
          args: [42n],
        }),
      },
      { target: ctx.wallets[3].account.address, value: BOND / 2n, data: "0x" },
    ];
    const id = await propose(actions);
    await vote(id, 1);
    await close(id);
    await assert.rejects(
      execute(id, [{ ...actions[0], value: 0n }, actions[1]]),
      /PayloadMismatch/,
    );
    await execute(id, actions);
    assert.equal(await target.read.value(), 42n);
    assert.equal(
      await ctx.client.getBalance({ address: target.address }),
      BOND / 2n,
    );
    assert.equal(
      await ctx.client.getBalance({ address: ctx.governor.address }),
      0n,
    );
    assert.equal(
      await ctx.registry.read.isCitizen([ctx.wallets[0].account.address]),
      true,
    );
  });
  it("rolls back every action on failure, and allows retry of the original payload", async () => {
    await join();
    const a = await ctx.viem.deployContract("TestTarget");
    const b = await ctx.viem.deployContract("TestTarget");
    await b.write.setRevert([true]);
    const actions: Action[] = [a, b].map((t) => ({
      target: t.address,
      value: 0n,
      data: encodeFunctionData({
        abi: t.abi,
        functionName: "setValue",
        args: [42n],
      }),
    }));
    const id = await propose(actions);
    await vote(id, 1);
    await close(id);
    await assert.rejects(execute(id, actions), /ActionFailed/);
    assert.equal(await a.read.value(), 0n);
    assert.equal((await ctx.governor.read.getProposal([id])).executed, false);
    await b.write.setRevert([false]);
    await execute(id, actions);
    assert.equal(await a.read.value(), 42n);
    assert.equal(await b.read.value(), 42n);
  });
  it("rejects an underfunded batch without consuming the proposal", async () => {
    await join();
    const actions: Action[] = [
      { target: ctx.wallets[3].account.address, value: BOND * 2n, data: "0x" },
    ];
    const id = await propose(actions);
    await vote(id, 1);
    await close(id);
    await assert.rejects(execute(id, actions), /InsufficientTreasury/);
    await ctx.wallets[0].sendTransaction({
      to: ctx.governor.address,
      value: BOND,
    });
    await execute(id, actions);
    assert.equal(await ctx.governor.read.state([id]), 3);
  });
  it("blocks recursive execution", async () => {
    await join();
    const target = await ctx.viem.deployContract("ReentryTarget");
    const actions: Action[] = [
      {
        target: target.address,
        value: 0n,
        data: encodeFunctionData({ abi: target.abi, functionName: "attack" }),
      },
    ];
    const id = await propose(actions);
    await target.write.configure([ctx.governor.address, id]);
    await vote(id, 1);
    await close(id);
    await execute(id, actions);
    assert.equal(await target.read.wasBlocked(), true);
    assert.equal(await ctx.governor.read.state([id]), 3);
  });
});
