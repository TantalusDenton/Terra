import {
  createPublicClient,
  fallback,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia, hardhat } from "viem/chains";
import abis from "./abis.json";
import deployment from "./deployment.json";

export const manifest = deployment;
export const chain = deployment.chainId === 31337 ? hardhat : baseSepolia;
export const registryAbi = abis.registry as Abi;
export const governorAbi = abis.governor as Abi;
export const registryAddress = deployment.registry as Address | null;
export const governorAddress = deployment.governor as Address | null;
export const isDeployed =
  deployment.status === "deployed" && !!registryAddress && !!governorAddress;
export const rpcTransport = () =>
  deployment.chainId === 31337
    ? http(deployment.rpcUrl, { timeout: 15000, retryCount: 1 })
    : fallback([
        http(deployment.rpcUrl, { timeout: 12000, retryCount: 1 }),
        http("https://base-sepolia-rpc.publicnode.com", {
          timeout: 12000,
          retryCount: 1,
        }),
      ]);
export const publicClient = createPublicClient({
  chain,
  transport: rpcTransport(),
});
export const CONTRIBUTION = 1000000000000000n;
export type Action = { target: Address; value: bigint; data: Hex };
export type ProposalCore = {
  proposer: Address;
  startsAt: bigint;
  endsAt: bigint;
  electorate: bigint;
  policyHash: Hex;
  actionsHash: Hex;
  yes: bigint;
  no: bigint;
  abstain: bigint;
  executed: boolean;
};
export type ProposalRecord = ProposalCore & {
  id: bigint;
  title: string;
  summary: string;
  body: string;
  actions: Action[];
  transactionHash: Hex;
};
export type Citizen = { id: bigint; joinedAt: bigint; joinedBlock: bigint };
export type Receipt = { hash: Hex; block: bigint; label: string };

export function explorer(kind: "tx" | "address", value: string) {
  return manifest.explorerUrl
    ? `${manifest.explorerUrl}/${kind}/${value}`
    : null;
}
export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
export function policyState(p: ProposalCore, now: number) {
  if (p.executed) return "Enacted";
  if (BigInt(now) < p.endsAt) return "Active";
  return p.yes > p.no ? "Passed" : "Rejected";
}
export function formatDate(timestamp: bigint) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(Number(timestamp) * 1000);
}

// Public RPC providers impose different log-range limits. Shrink ranges rather than dropping history.
export async function proposalEvents(fromBlock: bigint, toBlock: bigint) {
  if (!governorAddress) return [];
  const result = [];
  let cursor = fromBlock;
  let span = 2000n;
  while (cursor <= toBlock) {
    const end = cursor + span - 1n < toBlock ? cursor + span - 1n : toBlock;
    try {
      const logs = await publicClient.getContractEvents({
        address: governorAddress,
        abi: governorAbi,
        eventName: "ProposalCreated",
        fromBlock: cursor,
        toBlock: end,
        strict: true,
      });
      result.push(...logs);
      cursor = end + 1n;
      span = 2000n;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Smaller ranges fix provider range/result limits, not outages or rate limits.
      if (
        !/block range|too many results|query returned more than|response size|range.*limit|max.*blocks|limit.*blocks/i.test(
          message,
        )
      )
        throw error;
      if (span <= 1n) throw error;
      span = span / 2n;
    }
  }
  return result;
}

export function userError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    /UserRejectedRequestError|user rejected|user denied|request denied|4001/i.test(
      detail,
    )
  )
    return "You declined the wallet request. Nothing was changed.";
  if (/insufficient funds/i.test(detail))
    return "Your wallet needs more test ETH for the contribution and transaction fee.";
  const messages: Record<string, string> = {
    AlreadyCitizen: "This wallet already has permanent citizenship.",
    IncorrectContribution: "Citizenship requires exactly 0.001 test ETH.",
    NotCitizen: "Become a citizen before proposing or voting.",
    NotInElectorate:
      "Your citizenship began after this proposal was published. You can vote on later proposals.",
    AlreadyVoted: "This wallet has already voted. Ballots cannot be changed.",
    VotingClosed: "Voting has closed for this proposal.",
    NotPassed:
      "This proposal is not ready to execute. Voting must end with more Yes than No votes.",
    AlreadyExecuted: "This proposal has already been enacted.",
    PayloadMismatch: "The action payload does not match the original proposal.",
    InsufficientTreasury:
      "The public treasury cannot yet fund these actions. The proposal can be retried after funding.",
    ActionFailed:
      "An action reverted. No actions were applied; the original batch remains retryable.",
  };
  for (const [key, message] of Object.entries(messages))
    if (detail.includes(key)) return message;
  if (/network|chain|rpc|fetch|timeout|HTTP/i.test(detail))
    return "The blockchain connection is unavailable. Check your network and try again.";
  return "The transaction could not be completed. Review the proposal and wallet, then try again.";
}
