import { createPublicClient, defineChain, encodeAbiParameters, http, keccak256, type Abi, type Address, type Hex } from "viem";
import abis from "./abis.json";
import deployment from "./deployment.json";
import templates from "./verification-templates.json";
import directoryTemplate from "./directory-verification-template.json";
import rollupAnchor from "./rollup-anchor.json";
import type { Action, ProposalRecord } from "./terra";

export type Bridges = {
  settlementChainId: string; settlementRpcUrl: string; settlementName?: string;
  settlementExplorerUrl?: string; l1StandardBridge: Address; l2StandardBridge: Address;
  optimismPortal: Address; systemConfig: Address; disputeGameFactory?: Address;
};
export type Community = {
  id: string; kind: "terra" | "blockshares"; name: string; chainId: string;
  rpcUrl: string; explorerUrl?: string; governor: Address; registry: Address;
  deploymentBlock: string; status?: string; directory?: Address;
  logoUri?: string; logoHash?: Hex; genesisHash?: Hex; governorCodeHash?: Hex;
  registryCodeHash?: Hex; bridges?: Bridges; testnet?: boolean;
  chainSpecHash?: Hex; governanceVersion?: string; error?: string; statusMessage?: string;
  sourceDirectory?: Address; configurationHash?: Hex; directoryCodeHash?: Hex;
};
export type Source = { blockNumber: string; blockHash: Hex; timestamp?: string; finality: string; indexingLag: string; headBlockNumber: string };
export type SummaryResponse = { community: Community; source: Source; counts: { members: string; proposals: string }; treasuryBalanceWei: string };
export type PageResponse<T> = { items: T[]; nextCursor: string | null; source?: Source };
export type ProposalJson = Record<string, unknown> & { id: string; title: string; summary: string; proposer: Address; creationTx?: Hex; transactionHash?: Hex; actionCount?: number; body?: string; actions?: { target: Address; value?: string; valueWei?: string; data: Hex }[] };
export type ProposalCard = ProposalRecord & { actionCount: number };
export const rootCommunity: Community = {
  ...deployment, id: "terra", name: "Terra", kind: "terra", chainId: String(deployment.chainId),
  governor: deployment.governor as Address, registry: deployment.registry as Address, governorCodeHash: deployment.governorCodeHash as Hex, registryCodeHash: deployment.registryCodeHash as Hex, testnet: true,
};
export const protocolAbis = abis as Record<string, Abi>;
export function communityChain(community: Community) {
  const id = Number(community.chainId);
  const supported = Number.isSafeInteger(id) && id > 0;
  if (!supported && (!community.status || ["Active", "active", "deployed"].includes(community.status))) throw new Error("This chain identifier is outside the wallet runtime's supported range.");
  return defineChain({ id: supported ? id : 31337, name: !supported ? community.name + " — unsupported chain identifier" : community.kind === "terra" && id === 31337 ? "Hardhat local Terra" : community.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [supported ? community.rpcUrl : "http://127.0.0.1:1"] } },
    testnet: community.testnet !== false,
    ...(community.explorerUrl ? { blockExplorers: { default: { name: "Explorer", url: community.explorerUrl } } } : {}),
    ...(community.bridges ? { contracts: {
      portal: { [Number(community.bridges.settlementChainId)]: { address: community.bridges.optimismPortal } },
      l1StandardBridge: { [Number(community.bridges.settlementChainId)]: { address: community.bridges.l1StandardBridge } },
      systemConfig: { [Number(community.bridges.settlementChainId)]: { address: community.bridges.systemConfig } },
      ...(community.bridges.disputeGameFactory ? { disputeGameFactory: { [Number(community.bridges.settlementChainId)]: { address: community.bridges.disputeGameFactory } } } : {}),
    } } : {}),
  });
}
export function communityClient(community: Community) { return createPublicClient({ chain: communityChain(community), transport: http(community.rpcUrl, { timeout: 15000, retryCount: 1 }) }); }
export function communityAbis(community: Community) {
  return community.kind === "blockshares" ? { governor: protocolAbis.blocksharesGovernor, registry: protocolAbis.stockholderRegistry, member: "stockholders", count: "stockholderCount" } : { governor: protocolAbis.governor, registry: protocolAbis.registry, member: "citizens", count: "citizenCount" };
}
export function communityPath(community: Community, suffix = "") { return (community.kind === "terra" ? "" : "/blockshares/" + community.id) + (suffix || (community.kind === "terra" ? "/" : "")); }
export async function ledger<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/ledger/" + path, init);
  if (!response.ok) { const error = await response.json().catch(() => null) as { error?: string } | null; throw new Error(error?.error || "The indexed ledger is unavailable (" + response.status + ")."); }
  return response.json() as Promise<T>;
}
export function decodeProposal(data: ProposalJson): ProposalCard {
  const n = (key: string) => BigInt(String(data[key] ?? "0"));
  return { id: BigInt(data.id), title: data.title, summary: data.summary, body: data.body ?? "", proposer: data.proposer,
    startsAt: n("startsAt"), endsAt: n("endsAt"), electorate: n("electorate"), yes: n("yes"), no: n("no"), abstain: n("abstain"),
    policyHash: data.policyHash as Hex, actionsHash: data.actionsHash as Hex, executed: data.executed === true,
    transactionHash: (data.transactionHash ?? data.creationTx) as Hex,
    actions: (data.actions ?? []).map(a => ({ target: a.target, value: BigInt(a.valueWei ?? a.value ?? "0"), data: a.data })),
    actionCount: data.actionCount ?? data.actions?.length ?? 0 };
}
export function verifyPayload(proposal: ProposalRecord) {
  const policy = keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "string" }], [proposal.title, proposal.summary, proposal.body]));
  const actions = keccak256(encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], [proposal.actions as Action[]]));
  if (policy !== proposal.policyHash || actions !== proposal.actionsHash) throw new Error("The indexed policy or actions do not match their on-chain commitments.");
}
type RuntimeTemplate = { deployedBytecode: string; immutableReferences: Record<string, { start: number; length: number }[]> };
export function matchesRuntime(code: Hex, template: RuntimeTemplate, binding?: Address) {
  let expected = template.deployedBytecode.slice(2).toLowerCase(); let actual = code.slice(2).toLowerCase();
  if (actual.length !== expected.length) return false;
  for (const refs of Object.values(template.immutableReferences)) for (const ref of refs) {
    const start = ref.start * 2; const size = ref.length * 2;
    if (binding && size !== 64) throw new Error("Unexpected immutable address binding.");
    const value = binding ? binding.slice(2).toLowerCase().padStart(size, "0") : "0".repeat(size);
    expected = expected.slice(0, start) + value + expected.slice(start + size);
    if (!binding) actual = actual.slice(0, start) + value + actual.slice(start + size);
  }
  return actual === expected;
}
export async function verifyProposalOnchain(community: Community, proposal: ProposalRecord) {
  verifyPayload(proposal);
  const current = await communityClient(community).readContract({ address: community.governor, abi: communityAbis(community).governor, functionName: "getProposal", args: [proposal.id] }) as { policyHash: Hex; actionsHash: Hex; electorate: bigint; endsAt: bigint; proposer: Address };
  if (current.policyHash !== proposal.policyHash || current.actionsHash !== proposal.actionsHash || current.electorate !== proposal.electorate || current.endsAt !== proposal.endsAt || current.proposer.toLowerCase() !== proposal.proposer.toLowerCase()) throw new Error("The displayed proposal differs from its authoritative blockchain record. Refresh before signing.");
}
export async function verifyCommunity(community: Community) {
  if (community.status && !["active", "Active", "deployed"].includes(community.status)) throw new Error("This blockchain is not active yet.");
  if (!community.governorCodeHash || !community.registryCodeHash) throw new Error("Deployment verification hashes are missing.");
  const client = communityClient(community); const abi = communityAbis(community);
  const [id, governorCode, registryCode, registry, treasury, contribution, min, max, actions, bytes, genesis] = await Promise.all([
    client.getChainId(), client.getCode({ address: community.governor }), client.getCode({ address: community.registry }),
    client.readContract({ address: community.governor, abi: abi.governor, functionName: "registry" }),
    client.readContract({ address: community.registry, abi: abi.registry, functionName: "treasury" }),
    client.readContract({ address: community.registry, abi: abi.registry, functionName: "CONTRIBUTION" }),
    ...["MIN_DURATION", "MAX_DURATION", "MAX_ACTIONS", "MAX_POLICY_BYTES"].map(functionName => client.readContract({ address: community.governor, abi: abi.governor, functionName })),
    community.genesisHash ? client.getBlock({ blockNumber: 0n }) : Promise.resolve(null),
  ]);
  if (String(id) !== community.chainId || !governorCode || !registryCode || keccak256(governorCode) !== community.governorCodeHash || keccak256(registryCode) !== community.registryCodeHash || String(registry).toLowerCase() !== community.registry.toLowerCase() || String(treasury).toLowerCase() !== community.governor.toLowerCase() || contribution !== 1000000000000000n || min !== 3600n || max !== 2592000n || actions !== 8n || bytes !== 16384n || (genesis && (genesis as { hash: Hex }).hash !== community.genesisHash)) throw new Error("The deployment failed independent network, code, or governance verification.");
  const preservedLegacy = community.id === "terra" && community.kind === "terra" && community.chainId === rootCommunity.chainId && community.governor.toLowerCase() === rootCommunity.governor.toLowerCase() && community.registry.toLowerCase() === rootCommunity.registry.toLowerCase() && community.governorCodeHash === rootCommunity.governorCodeHash && community.registryCodeHash === rootCommunity.registryCodeHash;
  const governorTemplate = community.kind === "terra" ? templates.contracts.TerraGovernor : templates.contracts.BlocksharesGovernor;
  const registryTemplate = community.kind === "terra" ? templates.contracts.CitizenRegistry : templates.contracts.StockholderRegistry;
  if (!preservedLegacy && (!matchesRuntime(governorCode, governorTemplate, community.registry) || !matchesRuntime(registryCode, registryTemplate, community.governor))) throw new Error("The governance bytecode does not match the tested protocol implementation.");
  if (community.kind === "terra" && !preservedLegacy) {
    const trusted = rollupAnchor.terra as Partial<Community> | null;
    const fields = ["chainId", "governor", "registry", "genesisHash", "configurationHash", "directory", "directoryCodeHash", "governorCodeHash", "registryCodeHash"] as const;
    if (!trusted || fields.some(field => !trusted[field] || String(trusted[field]).toLowerCase() !== String(community[field]).toLowerCase())) throw new Error("This Terra deployment is not the locally verified, application-pinned root.");
    const bridgeFields = ["settlementChainId", "l1StandardBridge", "l2StandardBridge", "optimismPortal", "systemConfig", "disputeGameFactory"] as const;
    if (!trusted.bridges || !community.bridges || bridgeFields.some(field => !trusted.bridges?.[field] || String(trusted.bridges[field]).toLowerCase() !== String(community.bridges?.[field]).toLowerCase())) throw new Error("Terra's canonical bridge addresses differ from the locally verified root.");
    const directoryCode = await client.getCode({ address: community.directory! });
    if (!directoryCode || keccak256(directoryCode) !== trusted.directoryCodeHash || !matchesRuntime(directoryCode, directoryTemplate)) throw new Error("Terra's pinned creation directory failed code verification.");
  }
  if (community.bridges) {
    const bridges = community.bridges;
    if (bridges.l2StandardBridge.toLowerCase() !== "0x4200000000000000000000000000000000000010" || !community.genesisHash || !bridges.disputeGameFactory) throw new Error("Incomplete canonical bridge identity.");
    const settlement = createPublicClient({ transport: http(bridges.settlementRpcUrl, { timeout: 15000, retryCount: 1 }) });
    if (String(await settlement.getChainId()) !== bridges.settlementChainId) throw new Error("Wrong settlement network.");
    const codes = await Promise.all([settlement.getCode({ address: bridges.l1StandardBridge }), settlement.getCode({ address: bridges.optimismPortal }), settlement.getCode({ address: bridges.systemConfig }), settlement.getCode({ address: bridges.disputeGameFactory }), client.getCode({ address: bridges.l2StandardBridge })]);
    if (codes.some(code => !code || code === "0x")) throw new Error("A canonical bridge contract is missing.");
    const safe = await client.getBlock({ blockTag: "safe" });
    if (!safe.number || safe.timestamp + 120n < BigInt(Math.floor(Date.now() / 1000))) throw new Error("Safe blocks are stalled or unavailable.");
  }
  if (community.kind === "blockshares") {
    const protocol = await ledger<{ communities: Community[] }>("protocol");
    const terra = protocol.communities.find(item => item.id === "terra" && item.kind === "terra");
    if (!terra?.directory || (community.sourceDirectory && community.sourceDirectory.toLowerCase() !== terra.directory.toLowerCase())) throw new Error("The corporation is not bound to Terra's directory.");
    await verifyCommunity(terra);
    const root = communityClient(terra); const directoryAbi = protocolAbis.blocksharesDirectory;
    const [code, governor, request, approved] = await Promise.all([
      root.getCode({ address: terra.directory }), root.readContract({ address: terra.directory, abi: directoryAbi, functionName: "terraGovernor" }),
      root.readContract({ address: terra.directory, abi: directoryAbi, functionName: "getRequest", args: [BigInt(community.id)], blockTag: "finalized" }),
      root.readContract({ address: terra.directory, abi: directoryAbi, functionName: "getDeployment", args: [BigInt(community.id)], blockTag: "finalized" }),
    ]);
    if (!code || !matchesRuntime(code, directoryTemplate) || String(governor).toLowerCase() !== terra.governor.toLowerCase()) throw new Error("Unrecognized creation directory.");
    const r = request as { status: number; metadata: { name: string; logoURI: string; logoHash: Hex; chainId: bigint; chainSpecHash: Hex; governanceVersion: number } };
    const d = approved as Record<string, unknown>;
    const bindings = { chainId: community.chainId, governor: community.governor, registry: community.registry, genesisHash: community.genesisHash, configurationHash: community.configurationHash, governorCodeHash: community.governorCodeHash, registryCodeHash: community.registryCodeHash, settlementChainId: community.bridges?.settlementChainId, l1StandardBridge: community.bridges?.l1StandardBridge, l2StandardBridge: community.bridges?.l2StandardBridge, optimismPortal: community.bridges?.optimismPortal, systemConfig: community.bridges?.systemConfig };
    if (Number(r.status) !== 1 || r.metadata.name !== community.name || r.metadata.logoHash !== community.logoHash || r.metadata.logoURI !== community.logoUri || String(r.metadata.chainId) !== community.chainId || (community.chainSpecHash && r.metadata.chainSpecHash !== community.chainSpecHash) || String(r.metadata.governanceVersion) !== String(community.governanceVersion) || Object.entries(bindings).some(([key, value]) => !value || String(d[key]).toLowerCase() !== String(value).toLowerCase())) throw new Error("The selected deployment differs from Terra's finalized activation record.");
  }
  return { valid: true as const, checkedAt: Date.now() };
}
