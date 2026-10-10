import type { Address, Hex } from 'viem';

export interface Community {
  id: string;
  kind: 'terra' | 'blockshares';
  governanceKind?: string;
  name: string;
  chainId: string;
  rpcUrl: string;
  governor?: Address;
  registry?: Address;
  directory?: Address;
  deploymentBlock: string;
  explorerUrl?: string;
  governorCodeHash?: Hex;
  registryCodeHash?: Hex;
  genesisHash?: Hex;
  configurationHash?: Hex;
  logoUri?: string;
  logoHash?: Hex;
  status: 'Approved' | 'Provisioning' | 'Active' | 'Failed';
  statusMessage?: string;
  testnet: boolean;
  local: boolean;
  finality: 'finalized' | 'safe' | 'latest';
  bridges?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Source {
  blockNumber: string;
  blockHash: Hex;
  timestamp: string;
  finality: Community['finality'];
  indexingLag: string;
  headBlockNumber: string;
  updatedAt: string;
}

export interface Action { target: Address; value: string; data: Hex }
export interface PolicyContent { body: string; actions: Action[] }
export interface ProposalCard {
  id: string;
  title: string;
  summary: string;
  proposer: Address;
  startsAt: string;
  endsAt: string;
  electorate: string;
  yes: string;
  no: string;
  abstain: string;
  executed: boolean;
  policyHash: Hex;
  actionsHash: Hex;
  actionCount: number;
  creationTx: Hex;
  creationBlock: string;
  state: 'Active' | 'Defeated' | 'Passed' | 'Executed';
}
export type IndexedEvent = {
  communityKey: string;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  type: 'ProposalCreated' | 'VoteCast' | 'PolicyEnacted';
  proposalId: string;
  payload: Record<string, unknown>;
};

export function communityKey(community: Community): string {
  if (!community.governor) throw new Error('Community has no deployed governor');
  return `${community.chainId}:${community.governor.toLowerCase()}`;
}
export function json(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
}
export function decimal(value: unknown, label = 'identifier'): string {
  if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') ||
      !/^(0|[1-9]\d{0,77})$/.test(String(value))) throw new Error(`Invalid ${label}`);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Unsafe numeric ${label}; use a decimal string`);
  const result = BigInt(String(value));
  if (result > (1n << 256n) - 1n) throw new Error(`${label} exceeds uint256`);
  return result.toString();
}
