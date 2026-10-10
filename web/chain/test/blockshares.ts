import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, it } from "node:test";
import { artifacts, network } from "hardhat";
import { runtimeMatchesArtifact } from "../scripts/community-verification.mjs";
import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  getAddress,
  keccak256,
  parseEther,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
} from "viem";

const digest = (text: string) => keccak256(stringToHex(text));
const contractError = (name: string) => (error: unknown) => String(error).includes(name) || String(error).includes(toFunctionSelector(`${name}()`));
const bridge = "0x4200000000000000000000000000000000000010" as const;
const activationTypes = {
  Activation: [
    { name: "requestId", type: "uint256" },
    { name: "metadataHash", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "deploymentHash", type: "bytes32" },
    { name: "operatorEpoch", type: "uint256" },
  ],
} as const;

describe("Terra-governed Blockshares directory", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  async function setup() {
    const connection = await network.create("hardhat");
    const wallets = await connection.viem.getWalletClients();
    const client = await connection.viem.getPublicClient();
    const governor = await connection.viem.deployContract("TerraGovernor");
    const registry = await connection.viem.getContractAt("CitizenRegistry", await governor.read.registry());
    const operator = wallets[4];
    const directory = await connection.viem.deployContract("BlocksharesDirectory", [governor.address, operator.account.address]);
    await registry.write.join([], { value: parseEther("0.001"), account: wallets[0].account });
    return { connection, wallets, client, governor, registry, operator, directory };
  }
  beforeEach(async () => { ctx = await setup(); });
  function metadata(chainId = 901001n) {
    return {
      name: "Polar Research",
      logoURI: "http://127.0.0.1:5186/assets/" + digest("png logo"),
      logoHash: digest("png logo"),
      chainId,
      governanceVersion: 1,
      chainSpecHash: digest("immutable network specification"),
    };
  }
  function deployment(chainId = 901001n) {
    return {
      chainId,
      settlementChainId: 3151908n,
      genesisHash: digest("genesis"),
      configurationHash: digest("configuration"),
      governor: getAddress(ctx.wallets[10].account.address),
      registry: getAddress(ctx.wallets[11].account.address),
      l1StandardBridge: getAddress(ctx.wallets[12].account.address),
      l2StandardBridge: bridge,
      optimismPortal: getAddress(ctx.wallets[13].account.address),
      systemConfig: getAddress(ctx.wallets[14].account.address),
      governorCodeHash: digest("governor runtime"),
      registryCodeHash: digest("registry runtime"),
      manifestHash: digest("canonical manifest"),
    };
  }
  async function policy(action: { target: `0x${string}`; value: bigint; data: `0x${string}` }) {
    await ctx.governor.write.propose(["Create Blockshare", "", "Register the corporation with the original branding and chain specification.", 3600n, [action]]);
    const id = await ctx.governor.read.proposalCount();
    await ctx.governor.write.vote([id, 1]);
    const proposal = await ctx.governor.read.getProposal([id]);
    await ctx.connection.networkHelpers.time.increaseTo(proposal.endsAt);
    return { id, actions: [action] };
  }
  async function request(input = metadata()) {
    const action = {
      target: ctx.directory.address,
      value: 0n,
      data: encodeFunctionData({ abi: ctx.directory.abi, functionName: "requestCreation", args: [input] }),
    };
    const { id, actions } = await policy(action);
    const hash = await ctx.governor.write.execute([id, actions], { account: ctx.wallets[7].account });
    await ctx.client.waitForTransactionReceipt({ hash });
    return ctx.directory.read.requestCount();
  }
  async function typed(id: bigint, value = deployment(), signer = ctx.operator, domainOverride = {}) {
    const r = await ctx.directory.read.getRequest([id]);
    const message = {
      requestId: id,
      metadataHash: r.metadataHash,
      chainId: value.chainId,
      deploymentHash: await ctx.directory.read.hashDeployment([value]),
      operatorEpoch: await ctx.directory.read.operatorEpoch(),
    };
    const domain = { name: "Terra BlocksharesDirectory", version: "1", chainId: 31337, verifyingContract: ctx.directory.address, ...domainOverride };
    const payload = { account: signer.account, domain, types: activationTypes, primaryType: "Activation" as const, message };
    return { signature: await signer.signTypedData(payload), payload };
  }

  it("rejects invalid constructor roles", async () => {
    await assert.rejects(ctx.connection.viem.deployContract("BlocksharesDirectory", [zeroAddress, ctx.operator.account.address]), /InvalidGovernor/);
    await assert.rejects(ctx.connection.viem.deployContract("BlocksharesDirectory", [ctx.wallets[0].account.address, ctx.operator.account.address]), /InvalidGovernor/);
    await assert.rejects(ctx.connection.viem.deployContract("BlocksharesDirectory", [ctx.governor.address, zeroAddress]), /InvalidOperator/);
  });

  it("allows creation only from approved Terra execution and commits original branding/specification", async () => {
    const m = metadata();
    await assert.rejects(ctx.directory.write.requestCreation([m]), contractError("OnlyTerraGovernor"));
    await assert.rejects(ctx.directory.write.requestCreation([m], { account: ctx.operator.account }), contractError("OnlyTerraGovernor"));
    const id = await request(m);
    const r = await ctx.directory.read.getRequest([id]);
    assert.equal(id, 1n);
    assert.deepEqual(r.metadata, m);
    assert.equal(r.status, 0);
    assert.equal(r.activatedAt, 0n);
    assert(r.approvedAt > 0n);
    assert.equal(await ctx.directory.read.chainRequestId([m.chainId]), id);
    const metadataParameter = ctx.directory.abi.find((item) => item.type === "function" && item.name === "hashMetadata")!;
    assert.equal(r.metadataHash, keccak256(encodeAbiParameters(metadataParameter.inputs, [m])));
    const logs = await ctx.directory.getEvents.CreationRequested({ requestId: id }, { fromBlock: 0n });
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0].args.metadata, m);
    await assert.rejects(ctx.directory.read.getDeployment([id]), /NotActive/);
    const abifunctions = ctx.directory.abi.filter((entry) => entry.type === "function").map((entry) => entry.name);
    for (const forbidden of ["cancel", "updateRequest", "upgradeTo", "withdraw", "transferOwnership"])
      assert(!abifunctions.includes(forbidden));
  });

  it("reserves chain IDs once, including before activation, and rejects the Terra ID", async () => {
    await request();
    await assert.rejects(request(metadata()), /ActionFailed/);
    await assert.rejects(request(metadata(31337n)), /ActionFailed/);
    await assert.rejects(request(metadata(0n)), /ActionFailed/);
    assert.equal(await ctx.directory.read.requestCount(), 1n);
    await request(metadata(901002n));
    assert.equal(await ctx.directory.read.requestCount(), 2n);
  });

  it("rejects malformed or over-limit metadata while preserving the failed governance batch", async () => {
    for (const invalid of [
      { ...metadata(), name: "" },
      { ...metadata(), name: "é".repeat(65) },
      { ...metadata(), logoURI: "" },
      { ...metadata(), logoURI: "x".repeat(1025) },
      { ...metadata(), logoHash: zeroHash },
      { ...metadata(), chainSpecHash: zeroHash },
      { ...metadata(), governanceVersion: 0 },
    ]) {
      await assert.rejects(request(invalid), /ActionFailed/);
      assert.equal(await ctx.directory.read.requestCount(), 0n);
      const id = await ctx.governor.read.proposalCount();
      assert.equal((await ctx.governor.read.getProposal([id])).executed, false);
    }
    await request({ ...metadata(), name: "é".repeat(64), logoURI: "x".repeat(1024) });
    assert.equal(await ctx.directory.read.requestCount(), 1n);
  });

  it("permits escaped-text names without imposing editorial classification", async () => {
    const m = { ...metadata(), name: "<script>alert('logo')</script>" };
    const id = await request(m);
    assert.equal((await ctx.directory.read.getRequest([id])).metadata.name, m.name);
  });

  it("binds EIP712 to Terra chain, directory, request, metadata, child chain, deployment, and operator epoch", async () => {
    const id = await request();
    const value = deployment();
    const { signature, payload } = await typed(id, value);
    assert.equal(await ctx.directory.read.activationDigest([id, value]), hashTypedData(payload));
    await assert.rejects(ctx.directory.write.activate([id, value, "0x"]), /InvalidAttestation/);
    const wrongSigner = await typed(id, value, ctx.wallets[5]);
    await assert.rejects(ctx.directory.write.activate([id, value, wrongSigner.signature]), /InvalidAttestation/);
    const wrongChain = await typed(id, value, ctx.operator, { chainId: 84532 });
    await assert.rejects(ctx.directory.write.activate([id, value, wrongChain.signature]), /InvalidAttestation/);
    const otherDirectory = await ctx.connection.viem.deployContract("BlocksharesDirectory", [ctx.governor.address, ctx.operator.account.address]);
    const wrongDirectory = await typed(id, value, ctx.operator, { verifyingContract: otherDirectory.address });
    await assert.rejects(ctx.directory.write.activate([id, value, wrongDirectory.signature]), /InvalidAttestation/);
    const alteredMetadata = await ctx.operator.signTypedData({ ...payload, message: { ...payload.message, metadataHash: digest("different branding") } });
    await assert.rejects(ctx.directory.write.activate([id, value, alteredMetadata]), /InvalidAttestation/);
    const alteredRequest = await ctx.operator.signTypedData({ ...payload, message: { ...payload.message, requestId: id + 1n } });
    await assert.rejects(ctx.directory.write.activate([id, value, alteredRequest]), /InvalidAttestation/);
    const alteredEpoch = await ctx.operator.signTypedData({ ...payload, message: { ...payload.message, operatorEpoch: 1n } });
    await assert.rejects(ctx.directory.write.activate([id, value, alteredEpoch]), /InvalidAttestation/);
    await assert.rejects(ctx.directory.write.activate([id, { ...value, chainId: 901002n }, signature]), /InvalidDeployment/);
    for (const field of ["genesisHash", "configurationHash", "governorCodeHash", "registryCodeHash", "manifestHash"] as const)
      await assert.rejects(ctx.directory.write.activate([id, { ...value, [field]: digest("changed " + field) }, signature]), /InvalidAttestation/);
    for (const field of ["governor", "registry", "l1StandardBridge", "optimismPortal", "systemConfig"] as const)
      await assert.rejects(ctx.directory.write.activate([id, { ...value, [field]: ctx.wallets[9].account.address }, signature]), /InvalidAttestation/);
    await assert.rejects(ctx.directory.write.activate([id, { ...value, settlementChainId: 1n }, signature]), /InvalidAttestation/);
    assert.equal((await ctx.directory.read.getRequest([id])).status, 0);
    const hash = await ctx.directory.write.activate([id, value, signature], { account: ctx.wallets[7].account });
    await ctx.client.waitForTransactionReceipt({ hash });
    const r = await ctx.directory.read.getRequest([id]);
    assert.equal(r.status, 1);
    assert(r.activatedAt >= r.approvedAt);
    assert.deepEqual(await ctx.directory.read.getDeployment([id]), value);
    const logs = await ctx.directory.getEvents.BlockshareActivated({ requestId: id });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.deploymentHash, await ctx.directory.read.hashDeployment([value]));
    await assert.rejects(ctx.directory.write.activate([id, value, signature]), /AlreadyActive/);
  });

  it("rejects invalid deployment fields and permits an unchanged attestation to be retried after rejection", async () => {
    const id = await request();
    const value = deployment();
    const { signature } = await typed(id, value);
    const invalids = [
      { ...value, settlementChainId: 0n },
      { ...value, settlementChainId: value.chainId },
      { ...value, governor: value.registry },
      { ...value, l2StandardBridge: ctx.wallets[8].account.address },
      ...(["governor", "registry", "l1StandardBridge", "optimismPortal", "systemConfig"] as const).map((field) => ({ ...value, [field]: zeroAddress })),
      ...(["genesisHash", "configurationHash", "governorCodeHash", "registryCodeHash", "manifestHash"] as const).map((field) => ({ ...value, [field]: zeroHash })),
    ];
    for (const invalid of invalids) await assert.rejects(ctx.directory.write.activate([id, invalid, signature]), /InvalidDeployment/);
    await ctx.directory.write.activate([id, value, signature]);
    assert.equal((await ctx.directory.read.getRequest([id])).status, 1);
  });

  it("changes the operator only through Terra governance and invalidates unconsumed old signatures", async () => {
    const id = await request();
    const value = deployment();
    const old = await typed(id, value);
    const next = ctx.wallets[5];
    await assert.rejects(ctx.directory.write.rotateOperator([next.account.address]), /OnlyTerraGovernor/);
    const action = { target: ctx.directory.address, value: 0n, data: encodeFunctionData({ abi: ctx.directory.abi, functionName: "rotateOperator", args: [next.account.address] }) };
    const passed = await policy(action);
    await ctx.governor.write.execute([passed.id, passed.actions]);
    assert.equal((await ctx.directory.read.operator()).toLowerCase(), next.account.address.toLowerCase());
    assert.equal(await ctx.directory.read.operatorEpoch(), 1n);
    await assert.rejects(ctx.directory.write.activate([id, value, old.signature]), /InvalidAttestation/);
    await assert.rejects(ctx.directory.write.activate([id, value, (await typed(id, value)).signature]), /InvalidAttestation/);
    const current = await typed(id, value, next);
    await ctx.directory.write.activate([id, value, current.signature]);
    const invalidRotation = await policy({ ...action, data: encodeFunctionData({ abi: ctx.directory.abi, functionName: "rotateOperator", args: [zeroAddress] }) });
    await assert.rejects(ctx.governor.write.execute([invalidRotation.id, invalidRotation.actions]), /ActionFailed/);
    assert.equal(await ctx.directory.read.operatorEpoch(), 1n);
  });

  it("rejects unknown requests without creating phantom state", async () => {
    await assert.rejects(ctx.directory.read.getRequest([0n]), /UnknownRequest/);
    await assert.rejects(ctx.directory.read.getDeployment([1n]), /UnknownRequest/);
    await assert.rejects(ctx.directory.write.activate([1n, deployment(), "0x"]), /UnknownRequest/);
    assert.equal(await ctx.directory.read.requestCount(), 0n);
  });
});

describe("Independent Blockshares membership and treasury", () => {
  it("matches deployed runtime to tested artifacts while masking only immutable addresses", async () => {
    const connection = await network.create("hardhat");
    const client = await connection.viem.getPublicClient();
    const templates = JSON.parse(await readFile(new URL("../../lib/verification-templates.json", import.meta.url), "utf8")).contracts;
    for (const variant of [{ governor: "TerraGovernor", registry: "CitizenRegistry" }, { governor: "BlocksharesGovernor", registry: "StockholderRegistry" }] as const) {
      const governor = await connection.viem.deployContract(variant.governor);
      const governorArtifact = await artifacts.readArtifact(variant.governor);
      const registryArtifact = await artifacts.readArtifact(variant.registry);
      const governorCode = await client.getCode({ address: governor.address });
      const registryCode = await client.getCode({ address: await governor.read.registry() });
      assert(runtimeMatchesArtifact(governorCode, governorArtifact));
      assert(runtimeMatchesArtifact(registryCode, registryArtifact));
      for (const [template, code, expectedAddress] of [[templates[variant.governor], governorCode, await governor.read.registry()], [templates[variant.registry], registryCode, governor.address]]) {
        let expected = template.deployedBytecode.slice(2).toLowerCase();
        for (const refs of Object.values(template.immutableReferences) as { start: number; length: number }[][])
          for (const ref of refs) expected = expected.slice(0, ref.start * 2) + String(expectedAddress).slice(2).toLowerCase().padStart(64, "0") + expected.slice((ref.start + ref.length) * 2);
        assert.equal(code?.toLowerCase(), `0x${expected}`);
      }
      const mutated = `${governorCode!.slice(0, -2)}${governorCode!.endsWith("00") ? "01" : "00"}`;
      assert.equal(runtimeMatchesArtifact(mutated, governorArtifact), false);
      assert.equal(runtimeMatchesArtifact("0x", governorArtifact), false);
      assert.equal(runtimeMatchesArtifact(registryCode, governorArtifact), false);
    }
  });
  it("keeps the same wallet's two memberships, proposals, ballots, and treasury balances independent", async () => {
    const connection = await network.create("hardhat");
    const client = await connection.viem.getPublicClient();
    const wallets = await connection.viem.getWalletClients();
    const a = await connection.viem.deployContract("BlocksharesGovernor");
    const b = await connection.viem.deployContract("BlocksharesGovernor");
    const ar = await connection.viem.getContractAt("StockholderRegistry", await a.read.registry());
    const br = await connection.viem.getContractAt("StockholderRegistry", await b.read.registry());
    assert.notEqual(a.address, b.address);
    assert.notEqual(ar.address, br.address);
    assert.equal(await a.read.stockholderRegistry(), ar.address);
    await ar.write.join([], { value: parseEther("0.001") });
    assert.equal(await ar.read.stockholderCount(), 1n);
    assert.deepEqual(await ar.read.stockholders([wallets[0].account.address]), await ar.read.citizens([wallets[0].account.address]));
    assert.equal(await ar.read.isStockholder([wallets[0].account.address]), true);
    assert.equal(await br.read.isStockholder([wallets[0].account.address]), false);
    const input = ["Independent resolution", "", "The corporation decides only for its own treasury.", 3600n, []] as const;
    await a.write.propose(input);
    await assert.rejects(b.write.propose(input), /NotCitizen/);
    await br.write.join([], { value: parseEther("0.001") });
    await b.write.propose(input);
    await a.write.vote([1n, 1]);
    assert.equal((await a.read.getProposal([1n])).yes, 1n);
    assert.equal((await b.read.getProposal([1n])).yes, 0n);
    assert.equal(await b.read.ballots([1n, wallets[0].account.address]), 0);
    const beneficiary = wallets[2].account.address;
    const actions = [{ target: beneficiary, value: parseEther("0.001"), data: "0x" as const }];
    await a.write.propose(["Treasury transfer", "", "Spend A's funds only.", 3600n, actions]);
    await a.write.vote([2n, 1]);
    await connection.networkHelpers.time.increaseTo((await a.read.getProposal([2n])).endsAt);
    await a.write.execute([2n, actions]);
    assert.equal(await client.getBalance({ address: a.address }), 0n);
    assert.equal(await client.getBalance({ address: b.address }), parseEther("0.001"));
    assert.equal(await ar.read.isStockholder([wallets[0].account.address]), true);
    const events = await ar.getEvents.StockholdingGranted({}, { fromBlock: 0n });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.stockholderId, 1n);
  });

  for (const kind of ["CitizenRegistry", "StockholderRegistry"] as const)
    it(`${kind} blocks recursive enrollment without revoking completed membership`, async () => {
      const connection = await network.create("hardhat");
      const target = await connection.viem.deployContract("ReentryTreasury");
      const registry = await connection.viem.deployContract(kind, [target.address]);
      await target.write.configure([registry.address]);
      await target.write.enroll([], { value: parseEther("0.001") });
      assert.equal(await target.read.wasBlocked(), true);
      assert.equal(await registry.read.citizenCount(), 1n);
      assert.equal(await registry.read.isCitizen([target.address]), true);
      assert.equal(await (await connection.viem.getPublicClient()).getBalance({ address: target.address }), parseEther("0.001"));
    });
});
