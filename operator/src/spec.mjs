import { keccak256, stringToHex } from "viem";

export const networkSpecification = Object.freeze({
  format: "terra-op-stack-network/1",
  governanceVersion: 1,
  optimismPackage: "84cd0961fcce613558d7b260d8751a3ace533d31",
  opDeployer: "0.4.2",
  l1ContractArtifacts: "op-contracts/v4.0.0",
  l2ContractArtifacts: "op-contracts/v4.0.0",
  opGeth: "v1.101511.1",
  opNode: "v1.13.4",
  opBatcher: "v1.14.0",
  opProposer: "v1.10.0",
  settlementChainId: "3151908",
  blockTimeSeconds: 2,
  persistent: true,
  altDA: false,
  devAccountsFunded: true,
  finality: "finalized",
  joiningContributionWei: "1000000000000000",
  minimumProposalDuration: 3600,
  maximumProposalDuration: 2592000,
  maximumActions: 8,
  maximumPolicyBytes: 16384
});

export const chainSpecHash = keccak256(stringToHex(JSON.stringify(networkSpecification)));
export const publicNetworkSpecification = {
  governanceVersion: 1,
  chainSpecHash,
  description: "Persistent local OP Stack rollup settling on Terra's shared Ethereum development chain. Two-second blocks, canonical ETH bridge, permanent stockholders, one ballot per address.",
  settlementChainId: "3151908",
  specification: networkSpecification,
  specificationEncoding: "UTF-8 JSON.stringify(specification) with the recorded property order, Ethereum keccak256"
};

export function validateRequestSpecification(request) {
  if (Number(request.governanceVersion) !== 1 || request.chainSpecHash.toLowerCase() !== chainSpecHash.toLowerCase()) throw new Error("Approved network specification is unsupported; refusing to provision altered network parameters.");
  const id = BigInt(request.chainId);
  if (id === 2151908n || id === 3151908n || id <= 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Requested chain ID cannot be safely used by the OP Stack and wallet runtime.");
}
