// AI and human operators use this identical wallet protocol. No classification is sent.
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseEther,
  isAddress,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import { protocolChain, runtimeMatchesArtifact, verifyCommunityDeployment } from "./community-verification.mjs";

const defaultManifest = JSON.parse(
  await readFile(new URL("../../lib/deployment.json", import.meta.url), "utf8"),
);
const abi = JSON.parse(
  await readFile(new URL("../../lib/abis.json", import.meta.url), "utf8"),
);
const templates = JSON.parse(await readFile(new URL("../../lib/verification-templates.json", import.meta.url), "utf8")).contracts;
const directoryTemplate = JSON.parse(await readFile(new URL("../../lib/directory-verification-template.json", import.meta.url), "utf8"));
export const json = (value) =>
  JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );

export async function protocol(account, options = {}) {
  const source = options.manifest ?? defaultManifest;
  const selectedId = options.communityId ?? "terra";
  const manifest = Array.isArray(source.communities) ? source.communities.find(item => item.id === selectedId) : source;
  if (!manifest || !["deployed", "active"].includes(String(manifest.status).toLowerCase()))
    throw new Error(
      "The selected community is not active. Provision and verify its deployment first.",
    );
  const chain = protocolChain(manifest);
  const communityId = options.communityId ?? manifest.id ?? (manifest.kind === "blockshares" ? String(manifest.requestId ?? manifest.chainId) : "terra");
  const contractAbi = manifest.kind === "blockshares"
    ? { governor: abi.blocksharesGovernor, registry: abi.stockholderRegistry }
    : { governor: abi.governor, registry: abi.registry };
  const transport = http(options.rpcUrl ?? manifest.rpcUrl);
  const client = createPublicClient({ chain, transport });
  if ((await client.getChainId()) !== chain.id)
    throw new Error("RPC is on the wrong network.");
  const wallet = account
    ? createWalletClient({ chain, account, transport })
    : null;
  const publications = new Map();
  async function verifyIdentity() {
    const [id, governorCode, registryCode, linkedRegistry, treasury, genesis] = await Promise.all([
      client.getChainId(), client.getCode({ address: manifest.governor }), client.getCode({ address: manifest.registry }),
      client.readContract({ address: manifest.governor, abi: contractAbi.governor, functionName: "registry" }),
      client.readContract({ address: manifest.registry, abi: contractAbi.registry, functionName: "treasury" }),
      manifest.genesisHash ? client.getBlock({ blockNumber: 0n }) : Promise.resolve(null),
    ]);
    if (id !== chain.id || !governorCode || governorCode === "0x" || !registryCode || registryCode === "0x"
      || !manifest.governorCodeHash || keccak256(governorCode) !== manifest.governorCodeHash
      || !manifest.registryCodeHash || keccak256(registryCode) !== manifest.registryCodeHash
      || linkedRegistry.toLowerCase() !== manifest.registry.toLowerCase()
      || treasury.toLowerCase() !== manifest.governor.toLowerCase()
      || (genesis && genesis.hash !== manifest.genesisHash)) throw new Error("Community deployment identity, code, or registry/treasury wiring failed verification.");
    const corporate = manifest.kind === "blockshares";
    const governorTemplate = templates[corporate ? "BlocksharesGovernor" : "TerraGovernor"];
    const registryTemplate = templates[corporate ? "StockholderRegistry" : "CitizenRegistry"];
    const knownLegacyRoot = !corporate && String(manifest.chainId) === String(defaultManifest.chainId)
      && manifest.governor.toLowerCase() === defaultManifest.governor.toLowerCase()
      && manifest.registry.toLowerCase() === defaultManifest.registry.toLowerCase()
      && manifest.governorCodeHash === defaultManifest.governorCodeHash
      && manifest.registryCodeHash === defaultManifest.registryCodeHash;
    if (!knownLegacyRoot && (!runtimeMatchesArtifact(governorCode, governorTemplate) || !runtimeMatchesArtifact(registryCode, registryTemplate)))
      throw new Error("Selected governance runtime differs from the tested immutable protocol.");
    if (corporate) {
      const terra = source.communities?.find(item => item.id === "terra") ?? options.terraManifest;
      if (!terra?.directory || manifest.sourceDirectory?.toLowerCase() !== terra.directory.toLowerCase()) throw new Error("Provide the versioned multichain manifest, including Terra's creation directory.");
      await verifyCommunityDeployment(terra, { ...templates.TerraGovernor, abi: abi.governor }, { ...templates.CitizenRegistry, abi: abi.registry }, { requireSafeProgress: false });
      const root = createPublicClient({ chain: protocolChain(terra), transport: http(terra.rpcUrl) });
      const [code, governor, request, deployment] = await Promise.all([
        root.getCode({ address: terra.directory }), root.readContract({ address: terra.directory, abi: abi.blocksharesDirectory, functionName: "terraGovernor" }),
        root.readContract({ address: terra.directory, abi: abi.blocksharesDirectory, functionName: "getRequest", args: [BigInt(communityId)], blockTag: "finalized" }),
        root.readContract({ address: terra.directory, abi: abi.blocksharesDirectory, functionName: "getDeployment", args: [BigInt(communityId)], blockTag: "finalized" }),
      ]);
      const bindings = { chainId: manifest.chainId, governor: manifest.governor, registry: manifest.registry, genesisHash: manifest.genesisHash, configurationHash: manifest.configurationHash, governorCodeHash: manifest.governorCodeHash, registryCodeHash: manifest.registryCodeHash, settlementChainId: manifest.bridges?.settlementChainId, l1StandardBridge: manifest.bridges?.l1StandardBridge, l2StandardBridge: manifest.bridges?.l2StandardBridge, optimismPortal: manifest.bridges?.optimismPortal, systemConfig: manifest.bridges?.systemConfig };
      if (!runtimeMatchesArtifact(code, directoryTemplate) || governor.toLowerCase() !== terra.governor.toLowerCase() || Number(request.status) !== 1 || request.metadata.name !== manifest.name || request.metadata.logoURI !== manifest.logoUri || request.metadata.logoHash !== manifest.logoHash || request.metadata.chainSpecHash !== manifest.chainSpecHash || String(request.metadata.governanceVersion) !== String(manifest.governanceVersion) || Object.entries(bindings).some(([key, value]) => !value || String(deployment[key]).toLowerCase() !== String(value).toLowerCase())) throw new Error("Corporation metadata or deployment differs from Terra's finalized activation record.");
    }
  }
  async function send(address, contractAbi, functionName, args, value) {
    if (!wallet)
      throw new Error(
        "Set TERRA_AGENT_PRIVATE_KEY in your local process for signed transactions. Never put it in browser code or commit it.",
      );
    await verifyIdentity();
    const { request } = await client.simulateContract({
      address,
      abi: contractAbi,
      functionName,
      args,
      account,
      ...(value === undefined ? {} : { value }),
    });
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Transaction reverted.");
    return { ...receipt, chainId: chain.id, governor: manifest.governor,
      explorerUrl: manifest.explorerUrl ? `${manifest.explorerUrl}/tx/${hash}` : null };
  }
  async function membership(address = account?.address) {
    if (!address || !isAddress(address)) throw new Error("Provide a valid wallet address.");
    const [id, joinedAt, joinedBlock] = await client.readContract({ address: manifest.registry,
      abi: contractAbi.registry, functionName: manifest.kind === "blockshares" ? "stockholders" : "citizens", args: [address] });
    return { address, id, joinedAt, joinedBlock, chainId: String(chain.id), communityId };
  }
  const actionParameter = [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }];
  async function originalPayload(id, core, recovery = {}) {
    let record;
    const readApiUrl = options.readApiUrl ?? process.env.TERRA_READ_API_URL;
    if (readApiUrl) {
      const response = await fetch(`${readApiUrl.replace(/\/$/, "")}/v1/communities/${encodeURIComponent(communityId)}/proposals/${id}`);
      if (!response.ok) throw new Error("The indexed original payload is unavailable. Preserve the proposal and retry when indexing recovers.");
      const data = await response.json();
      record = data.proposal;
    } else {
      let fromBlock = recovery.creationBlock ?? publications.get(id.toString());
      let toBlock = fromBlock;
      if (fromBlock === undefined) {
        // A historical timestamp lookup requires logarithmically bounded block reads,
        // followed by one narrow log range, rather than rescanning all history.
        const head = await client.getBlockNumber();
        async function lowerBound(timestamp) {
          let low = BigInt(manifest.deploymentBlock);
          let high = head + 1n;
          while (low < high) {
            const mid = (low + high) / 2n;
            const block = await client.getBlock({ blockNumber: mid });
            if (block.timestamp < timestamp) low = mid + 1n;
            else high = mid;
          }
          return low;
        }
        fromBlock = await lowerBound(core.startsAt);
        toBlock = (await lowerBound(core.startsAt + 1n)) - 1n;
        if (toBlock < fromBlock || toBlock - fromBlock >= 2000n) throw new Error("Creation block range could not be recovered safely. Supply creationBlock or an indexed read API.");
      }
      const logs = await client.getContractEvents({ address: manifest.governor, abi: contractAbi.governor,
        eventName: "ProposalCreated", args: { proposalId: id }, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock), strict: true });
      if (logs.length !== 1) throw new Error("Cannot recover the original proposal payload from its creation block.");
      record = logs[0].args;
    }
    if (!record || typeof record.title !== "string" || typeof record.summary !== "string" || typeof record.body !== "string") throw new Error("Original policy text is missing.");
    const actions = record.actions.map(action => ({ target: action.target, value: BigInt(action.valueWei ?? action.value), data: action.data }));
    const policyHash = keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "string" }], [record.title, record.summary, record.body]));
    const actionsHash = keccak256(encodeAbiParameters(actionParameter, [actions]));
    if (policyHash !== core.policyHash || actionsHash !== core.actionsHash) throw new Error("Recovered policy or actions do not match their on-chain commitments.");
    return { ...record, actions };
  }
  return {
    manifest,
    client,
    account,
    communityId,
    membership,
    citizenship: membership,
    stockholding: membership,
    async join() {
      return send(
        manifest.registry,
        contractAbi.registry,
        "join",
        [],
        parseEther("0.001"),
      );
    },
    async propose({ title, summary, body, durationSeconds, actions = [] }) {
      if (![title, summary, body].every((value) => typeof value === "string"))
        throw new Error("Policy text must be strings.");
      if (!title.length || !body.length || new TextEncoder().encode(title + summary + body).length > 16384)
        throw new Error("A title and full policy are required, at most 16 KiB including summary.");
      if (
        !Number.isSafeInteger(durationSeconds) ||
        durationSeconds < 3600 ||
        durationSeconds > 2592000
      )
        throw new Error("Duration must be 3600–2592000 whole seconds.");
      if (!Array.isArray(actions) || actions.length > 8)
        throw new Error("At most eight actions are allowed.");
      const parsed = actions.map((action) => {
        if (
          !isAddress(action.target) ||
          !/^0x(?:[a-fA-F0-9]{2})*$/.test(action.data) ||
          typeof action.valueWei !== "string" ||
          !/^\d+$/.test(action.valueWei)
        )
          throw new Error(
            "Actions need target, decimal valueWei string, and hex data.",
          );
        return {
          target: action.target,
          value: BigInt(action.valueWei),
          data: action.data,
        };
      });
      const receipt = await send(manifest.governor, contractAbi.governor, "propose", [
        title,
        summary,
        body,
        BigInt(durationSeconds),
        parsed,
      ]);
      const event = receipt.logs
        .map((log) => {
          try {
            return decodeEventLog({
              abi: contractAbi.governor,
              data: log.data,
              topics: log.topics,
            });
          } catch {
            return null;
          }
        })
        .find((event) => event?.eventName === "ProposalCreated");
      if (!event) throw new Error("Confirmed transaction contained no proposal publication.");
      publications.set(event.args.proposalId.toString(), receipt.blockNumber);
      if (publications.size > 128) publications.delete(publications.keys().next().value);
      return {
        proposalId: event.args.proposalId,
        transactionHash: receipt.transactionHash,
        creationBlock: receipt.blockNumber,
        chainId: String(chain.id),
        communityId,
      };
    },
    async vote(id, choice) {
      const encoded = { No: 0, Yes: 1, Abstain: 2 };
      if (!Object.hasOwn(encoded, choice))
        throw new Error("Choice must be Yes, No, or Abstain.");
      return send(manifest.governor, contractAbi.governor, "vote", [
        BigInt(id),
        encoded[choice],
      ]);
    },
    async execute(id, recovery = {}) {
      const core = await client.readContract({ address: manifest.governor, abi: contractAbi.governor, functionName: "getProposal", args: [BigInt(id)] });
      const payload = await originalPayload(BigInt(id), core, recovery);
      return send(manifest.governor, contractAbi.governor, "execute", [
        BigInt(id),
        payload.actions,
      ]);
    },
    async proposal(id) {
      return client.readContract({
        address: manifest.governor,
        abi: contractAbi.governor,
        functionName: "getProposal",
        args: [BigInt(id)],
      });
    },
    creationAction(metadata) {
      if (manifest.kind === "blockshares" || !isAddress(manifest.directory)) throw new Error("Only Terra proposals can create Blockshares corporations.");
      return { target: manifest.directory, valueWei: "0", data: encodeFunctionData({ abi: abi.blocksharesDirectory, functionName: "requestCreation", args: [metadata] }) };
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [command, arg, choice] = process.argv.slice(2);
    const account = process.env.TERRA_AGENT_PRIVATE_KEY
      ? privateKeyToAccount(process.env.TERRA_AGENT_PRIVATE_KEY)
      : undefined;
    const selectedManifest = process.env.TERRA_AGENT_MANIFEST ? JSON.parse(await readFile(process.env.TERRA_AGENT_MANIFEST, "utf8")) : defaultManifest;
    const terra = await protocol(account, { manifest: selectedManifest, communityId: process.env.TERRA_COMMUNITY_ID, rpcUrl: process.env.TERRA_RPC_URL });
    let result;
    if (command === "status")
      result = {
        manifest: terra.manifest,
        citizenship: arg || account ? await terra.citizenship(arg) : null,
        treasuryWei: await terra.client.getBalance({
          address: terra.manifest.governor,
        }),
      };
    else if (command === "join") result = await terra.join();
    else if (command === "propose")
      result = await terra.propose(JSON.parse(await readFile(arg, "utf8")));
    else if (command === "vote") result = await terra.vote(arg, choice);
    else if (command === "execute") result = await terra.execute(arg);
    else if (command === "proposal") result = await terra.proposal(arg);
    else
      throw new Error(
        "Use status [address], join, propose policy.json, vote ID Yes|No|Abstain, proposal ID, or execute ID.",
      );
    console.log(json(result));
  } catch (error) {
    // Deliberately avoid printing a signer, request object, or environment variables.
    console.error(error.shortMessage ?? error.message);
    process.exitCode = 1;
  }
}
