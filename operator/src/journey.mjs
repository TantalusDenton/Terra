// Resumable live local acceptance journey. No time travel, mock RPC, or public-chain signing.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, keccak256, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildProveWithdrawal, getGame, getL2TransactionHashes, getWithdrawals, getWithdrawalStatus } from "viem/op-stack";
import { atomicJson, readJson, acquireProcessLock } from "./storage.mjs";
import { manifestPath, projectRoot, stateRoot } from "./config.mjs";
import { protocolChain, verifyCommunityDeployment } from "../../web/chain/scripts/community-verification.mjs";
import { chainSpecHash } from "./spec.mjs";

// These are deliberately public upstream development fixtures, never production secrets.
const actor = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const alternate = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const settlementFunder = privateKeyToAccount("0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31");
const abis = await readJson(resolve(projectRoot, "web/lib/abis.json"));
const artifact = name => readJson(resolve(projectRoot, `web/chain/artifacts/contracts/${name}.sol/${name}.json`));
const bridgeAbi = parseAbi(["function bridgeETHTo(address to,uint32 minGasLimit,bytes extraData) payable"]);
const portalAbi = parseAbi([
  "function proveWithdrawalTransaction((uint256 nonce,address sender,address target,uint256 value,uint256 gasLimit,bytes data) withdrawal,uint256 l2OutputIndex,(bytes32 version,bytes32 stateRoot,bytes32 messagePasserStorageRoot,bytes32 latestBlockhash) outputRootProof,bytes[] withdrawalProof)",
  "function finalizeWithdrawalTransactionExternalProof((uint256 nonce,address sender,address target,uint256 value,uint256 gasLimit,bytes data) withdrawal,address proofSubmitter)",
  "function proofMaturityDelaySeconds() view returns (uint256)", "function disputeGameFinalityDelaySeconds() view returns (uint256)",
]);
const path = resolve(stateRoot, "live-journey.json");
let state;
const save = () => atomicJson(path, state);
const clientFor = spec => createPublicClient({ chain: protocolChain(spec), transport: http(spec.rpcUrl, { timeout: 15000 }) });
function local(spec) {
  const url = new URL(spec.rpcUrl);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Acceptance signing is restricted to loopback RPCs.");
  assert(spec.testnet !== false, "Acceptance signing never runs on mainnet.");
}
async function transaction(label, spec, to, data = "0x", value = 0n, signer = actor) {
  local(spec); const client = clientFor(spec);
  assert.equal(String(await client.getChainId()), String(spec.chainId));
  const genesis = await client.getBlock({ blockNumber: 0n });
  if (spec.genesisHash) assert.equal(genesis.hash, spec.genesisHash);
  const binding = { chainId: String(spec.chainId), genesisHash: genesis.hash, to, data, value: value.toString(), from: signer.address };
  let checkpoint = state.operations[label];
  const wallet = createWalletClient({ chain: protocolChain(spec), account: signer, transport: http(spec.rpcUrl) });
  if (checkpoint) assert.deepEqual(checkpoint.binding, binding, "A resumed operation cannot change its original chain or payload.");
  else {
    await client.call({ to, data, value, account: signer.address });
    const request = await wallet.prepareTransactionRequest({ to, data, value });
    const serializedTransaction = await wallet.signTransaction(request);
    checkpoint = { binding, serializedTransaction, hash: keccak256(serializedTransaction) };
    state.operations[label] = checkpoint; await save();
  }
  try { await client.getTransaction({ hash: checkpoint.hash }); }
  catch { await wallet.sendRawTransaction({ serializedTransaction: checkpoint.serializedTransaction }); }
  const receipt = await client.waitForTransactionReceipt({ hash: checkpoint.hash, timeout: 120000 });
  assert.equal(receipt.status, "success", `${label} reverted; retain its original journal.`);
  checkpoint.blockNumber = receipt.blockNumber.toString(); checkpoint.status = "confirmed"; await save();
  return receipt;
}
const call = (label, spec, target, abi, functionName, args = [], value = 0n, signer = actor) => transaction(label, spec, target, encodeFunctionData({ abi, functionName, args }), value, signer);
function event(receipt, abi, name, address) {
  for (const log of receipt.logs) if (log.address.toLowerCase() === address.toLowerCase()) {
    try { const parsed = decodeEventLog({ abi, topics: log.topics, data: log.data }); if (parsed.eventName === name) return parsed.args; } catch {}
  }
  throw new Error(`Missing confirmed ${name} event.`);
}
async function verify(spec) {
  local(spec); const corporate = spec.kind === "blockshares";
  return verifyCommunityDeployment(spec, await artifact(corporate ? "BlocksharesGovernor" : "TerraGovernor"), await artifact(corporate ? "StockholderRegistry" : "CitizenRegistry"), { requireSafeProgress: false });
}
async function member(spec, wallet = actor) {
  const corporate = spec.kind === "blockshares";
  const [id] = await clientFor(spec).readContract({ address: spec.registry, abi: corporate ? abis.stockholderRegistry : abis.registry, functionName: corporate ? "stockholders" : "citizens", args: [wallet.address] });
  return id;
}
async function ballot(spec, id, label, signer = actor, choice = 1) {
  const abi = spec.kind === "blockshares" ? abis.blocksharesGovernor : abis.governor;
  const recorded = await clientFor(spec).readContract({ address: spec.governor, abi, functionName: "ballots", args: [BigInt(id), signer.address] });
  if (!recorded) await call(label, spec, spec.governor, abi, "vote", [BigInt(id), choice], 0n, signer);
  else assert.equal(Number(recorded), choice + 1, "An existing immutable ballot differs from this acceptance journey.");
}
async function readyToExecute(spec, id, label, actions) {
  const abi = spec.kind === "blockshares" ? abis.blocksharesGovernor : abis.governor; const client = clientFor(spec);
  const proposal = await client.readContract({ address: spec.governor, abi, functionName: "getProposal", args: [BigInt(id)] });
  if (proposal.executed) return state.operations[label] ? client.getTransactionReceipt({ hash: state.operations[label].hash }) : null;
  if ((await client.getBlock()).timestamp < proposal.endsAt) return { waitingUntil: proposal.endsAt.toString() };
  assert(proposal.yes > proposal.no, "Acceptance proposal did not pass.");
  return call(label, spec, spec.governor, abi, "execute", [BigInt(id), actions]);
}

export async function journey() {
  const manifest = await readJson(manifestPath); assert.equal(manifest.profile, "local-op-stack");
  const terra = manifest.communities.find(item => item.id === "terra"); assert(terra?.directory);
  assert.equal(String(terra.chainId), "2151908"); assert.equal(String(terra.bridges.settlementChainId), "3151908");
  await verify(terra);
  const identity = { chainId: terra.chainId, governor: terra.governor, registry: terra.registry, directory: terra.directory, genesisHash: terra.genesisHash };
  if (state.root) assert.deepEqual(state.root, identity, "Do not replace this acceptance journey's original Terra ledger.");
  else { state.root = identity; await save(); }
  const l1Spec = { chainId: "3151908", name: "Local Ethereum settlement", rpcUrl: terra.bridges.settlementRpcUrl, testnet: true };
  local(l1Spec); const l1 = clientFor(l1Spec);
  if (await l1.getBalance({ address: actor.address }) < parseEther("0.1")) await transaction("settlement-funding", l1Spec, actor.address, "0x", parseEther("0.2"), settlementFunder);
  if (!await member(terra)) await call("terra-enrollment", terra, terra.registry, abis.registry, "join", [], parseEther("0.001"));
  if (!state.logo) {
    const bytes = await readFile(resolve(projectRoot, "web/public/terra-crest.png"));
    const hash = keccak256(bytes); const issued = Math.floor(Date.now() / 1000);
    const message = `Terra logo upload\nChain: ${terra.chainId}\nRegistry: ${terra.registry.toLowerCase()}\nWallet: ${actor.address.toLowerCase()}\nHash: ${hash}\nIssuedAt: ${issued}`;
    const signature = await actor.signMessage({ message });
    const response = await fetch("http://127.0.0.1:5190/v1/logos", { method: "POST", headers: { "content-type": "image/png", "x-terra-wallet": actor.address, "x-terra-signature": signature, "x-terra-message": Buffer.from(message).toString("base64url") }, body: bytes });
    if (!response.ok) throw new Error("Acceptance logo upload failed: " + await response.text());
    state.logo = await response.json(); assert.equal(state.logo.hash, hash); await save();
  }
  if (!state.corporations.length) {
    const client = clientFor(terra); let id = 5210001n;
    for (const name of ["Aurora Acceptance Corporation", "Commons Acceptance Corporation"]) {
      while (await client.readContract({ address: terra.directory, abi: abis.blocksharesDirectory, functionName: "chainRequestId", args: [id] })) id++;
      state.corporations.push({ name, chainId: id.toString() }); id++;
    }
    await save();
  }
  const actions = state.corporations.map(item => ({ target: terra.directory, value: 0n, data: encodeFunctionData({ abi: abis.blocksharesDirectory, functionName: "requestCreation", args: [{ name: item.name, logoURI: state.logo.uri, logoHash: state.logo.hash, chainId: BigInt(item.chainId), governanceVersion: 1, chainSpecHash }] }) }));
  if (!state.creationProposal) {
    const receipt = await call("creation-publication", terra, terra.governor, abis.governor, "propose", ["Create two independent acceptance corporations", "Local verification only; each has equal permanent stockholders.", JSON.stringify({ purpose: "Verify two separate rollups, original branding, isolated memberships, treasury balances, ballots, enactment and canonical ETH bridging.", corporations: state.corporations, logo: state.logo, chainSpecHash }), 3600n, actions]);
    state.creationProposal = event(receipt, abis.governor, "ProposalCreated", terra.governor).proposalId.toString(); await save();
  }
  await ballot(terra, state.creationProposal, "creation-ballot");
  const approval = await readyToExecute(terra, state.creationProposal, "creation-execution", actions);
  if (approval?.waitingUntil) return { stage: "Terra voting", minimumDurationSeconds: 3600, ...approval };
  for (const item of state.corporations) {
    item.id = (await clientFor(terra).readContract({ address: terra.directory, abi: abis.blocksharesDirectory, functionName: "chainRequestId", args: [BigInt(item.chainId)] })).toString();
    assert(BigInt(item.id) > 0n); await save();
  }
  const selected = state.corporations.map(item => manifest.communities.find(community => community.id === item.id && community.status === "Active"));
  if (selected.some(item => !item)) return { stage: "Approved; awaiting finalized operator provisioning", requests: state.corporations.map(item => item.id), operatorCommand: "npm start" };
  assert.notEqual(selected[0].chainId, selected[1].chainId); assert.notEqual(selected[0].genesisHash, selected[1].genesisHash);
  const pending = [];
  for (let index = 0; index < selected.length; index++) {
    const community = selected[index]; const item = state.corporations[index]; const prefix = "corporation-" + item.id; const client = clientFor(community); await verify(community);
    const deposit = await call(prefix + "-deposit", l1Spec, community.bridges.l1StandardBridge, bridgeAbi, "bridgeETHTo", [actor.address, 200000, "0x"], parseEther("0.02"));
    const deposits = getL2TransactionHashes(deposit); assert(deposits.length);
    const receipts = await Promise.all(deposits.map(hash => client.getTransactionReceipt({ hash }).catch(() => null)));
    if (receipts.some(receipt => !receipt)) { pending.push({ id: item.id, stage: "Canonical deposit relay" }); continue; }
    assert(receipts.every(receipt => receipt.status === "success")); item.depositRollupReceipts = receipts.map(receipt => receipt.transactionHash); await save();
    if (!await member(community)) await call(prefix + "-enrollment", community, community.registry, abis.stockholderRegistry, "join", [], parseEther("0.001"));
    if (!index && !await member(community, alternate)) {
      if (await client.getBalance({ address: alternate.address }) < parseEther("0.002")) await transaction(prefix + "-alternate-funding", community, alternate.address, "0x", parseEther("0.005"));
      await call(prefix + "-alternate-enrollment", community, community.registry, abis.stockholderRegistry, "join", [], parseEther("0.001"), alternate);
    }
    if (index) assert.equal(await member(community, alternate), 0n, "An unrelated corporation inherited stockholding.");
    assert.equal(await member(terra, alternate), 0n, "Corporate stockholding must not grant Terra citizenship.");
    if (!item.proposalId) {
      const receipt = await call(prefix + "-publication", community, community.governor, abis.blocksharesGovernor, "propose", ["Affirm permanent equal stockholding", "One wallet, one vote; humans and AIs share equal standing.", "Every stockholder has equal rights to propose resolutions and vote. This policy is an immutable text-only corporate record.", 3600n, []]);
      item.proposalId = event(receipt, abis.blocksharesGovernor, "ProposalCreated", community.governor).proposalId.toString(); await save();
    }
    await ballot(community, item.proposalId, prefix + "-ballot");
    if (!index) await ballot(community, item.proposalId, prefix + "-alternate-ballot", alternate, 2);
    const proposal = await client.readContract({ address: community.governor, abi: abis.blocksharesGovernor, functionName: "getProposal", args: [BigInt(item.proposalId)] });
    assert.equal(proposal.yes, 1n); assert.equal(proposal.abstain, index ? 0n : 1n);
    assert.equal(await client.getBalance({ address: community.governor }), parseEther(index ? "0.001" : "0.002"));
    const enacted = await readyToExecute(community, item.proposalId, prefix + "-execution", []);
    if (enacted?.waitingUntil) { pending.push({ id: item.id, stage: "Corporate voting", ...enacted }); continue; }
    const withdrawal = await call(prefix + "-withdrawal", community, community.bridges.l2StandardBridge, bridgeAbi, "bridgeETHTo", [actor.address, 200000, "0x"], parseEther("0.005"));
    const [message] = getWithdrawals(withdrawal); assert(message);
    const addresses = { portalAddress: community.bridges.optimismPortal, disputeGameFactoryAddress: community.bridges.disputeGameFactory };
    let status = await getWithdrawalStatus(l1, { receipt: withdrawal, ...addresses });
    const delays = await Promise.all(["proofMaturityDelaySeconds", "disputeGameFinalityDelaySeconds"].map(functionName => l1.readContract({ address: addresses.portalAddress, abi: portalAbi, functionName })));
    item.bridgeDelaysSeconds = delays.map(String); item.withdrawalStatus = status; await save();
    if (status === "ready-to-prove") {
      const game = await getGame(l1, { l2BlockNumber: withdrawal.blockNumber, ...addresses });
      const proof = await buildProveWithdrawal(client, { account: actor.address, game, withdrawal: message });
      await call(prefix + "-proof", l1Spec, addresses.portalAddress, portalAbi, "proveWithdrawalTransaction", [proof.withdrawal, proof.l2OutputIndex, proof.outputRootProof, proof.withdrawalProof]);
      status = await getWithdrawalStatus(l1, { receipt: withdrawal, ...addresses });
    }
    if (status === "ready-to-finalize") {
      await call(prefix + "-finalization", l1Spec, addresses.portalAddress, portalAbi, "finalizeWithdrawalTransactionExternalProof", [message, actor.address]);
      status = await getWithdrawalStatus(l1, { receipt: withdrawal, ...addresses });
    }
    item.withdrawalStatus = status; await save();
    if (status !== "finalized") pending.push({ id: item.id, stage: status, bridgeDelaysSeconds: item.bridgeDelaysSeconds });
  }
  if (pending.length) return { stage: "Waiting for actual chain conditions", pending };
  state.completedAt = new Date().toISOString(); await save();
  return { stage: "Live transaction journey complete", journal: path, corporations: state.corporations, note: "Service restart/ledger preservation and browser wallet QA are separate checks; not inferred from these receipts." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = await acquireProcessLock(resolve(stateRoot, "journey.lock"));
  try {
    state = await readJson(path, { version: 1, operations: {}, corporations: [] });
    console.log(JSON.stringify(await journey(), null, 2));
  } catch (error) { console.error(error.shortMessage ?? error.message); process.exitCode = 1; }
  finally { await release(); }
}
