import { createPublicClient, http, parseAbi, type Address, type Hex, type Log } from 'viem';
import type { Community } from './types.js';

export interface ChainBlock { number: bigint; hash: Hex; timestamp: bigint }
export interface ChainRpc {
  head(): Promise<ChainBlock>;
  target(finality: Community['finality']): Promise<ChainBlock>;
  block(number: bigint): Promise<ChainBlock>;
  logs(address: Address, from: bigint, to: bigint): Promise<Log[]>;
  totals(governor: Address, registry: Address, block: bigint): Promise<{ members: bigint; proposals: bigint }>;
  proposal(governor: Address, id: bigint, block: bigint): Promise<{yes:bigint;no:bigint;abstain:bigint;executed:boolean}>;
  balance(address: Address, block: bigint): Promise<bigint>;
  isCitizen(registry: Address, address: Address): Promise<boolean>;
  verifyMessage(address: Address, message: string, signature: Hex): Promise<boolean>;
  identity(): Promise<number>;
}
const totalsAbi = parseAbi(['function citizenCount() view returns(uint256)', 'function proposalCount() view returns(uint256)', 'function isCitizen(address) view returns(bool)', 'function getProposal(uint256) view returns((address proposer,uint64 startsAt,uint64 endsAt,uint256 electorate,bytes32 policyHash,bytes32 actionsHash,uint256 yes,uint256 no,uint256 abstain,bool executed))']);
const signatures = parseAbi([
  'event ProposalCreated(uint256 indexed proposalId,address indexed proposer,string title,string summary,string body,uint64 endsAt,uint256 electorate,(address target,uint256 value,bytes data)[] actions,bytes32 policyHash,bytes32 actionsHash)',
  'event VoteCast(uint256 indexed proposalId,address indexed voter,uint8 choice,uint256 weight)',
  'event PolicyEnacted(uint256 indexed proposalId,bytes32 indexed policyHash)',
]);
export const governanceEvents = signatures;
export class ViemChainRpc implements ChainRpc {
  private client;
  constructor(url: string) { this.client = createPublicClient({ transport: http(url, { timeout: 12_000, retryCount: 1 }) }); }
  private normalize(block: { number: bigint | null; hash: Hex | null; timestamp: bigint }): ChainBlock {
    if (block.number === null || block.hash === null) throw new Error('Pending block cannot be indexed');
    return { number: block.number, hash: block.hash, timestamp: block.timestamp };
  }
  async head(): Promise<ChainBlock> { return this.normalize(await this.client.getBlock({ blockTag: 'latest' })); }
  async target(finality: Community['finality']): Promise<ChainBlock> { return this.normalize(await this.client.getBlock({ blockTag: finality })); }
  async block(number: bigint): Promise<ChainBlock> { return this.normalize(await this.client.getBlock({ blockNumber: number })); }
  async logs(address: Address, from: bigint, to: bigint): Promise<Log[]> {
    return this.client.getLogs({ address, events: governanceEvents, fromBlock: from, toBlock: to, strict: true });
  }
  async totals(governor: Address, registry: Address, block: bigint): Promise<{ members: bigint; proposals: bigint }> {
    const [members, proposals] = await Promise.all([
      this.client.readContract({ address: registry, abi: totalsAbi, functionName: 'citizenCount', blockNumber: block }),
      this.client.readContract({ address: governor, abi: totalsAbi, functionName: 'proposalCount', blockNumber: block }),
    ]);
    return { members, proposals };
  }
  async balance(address: Address, block: bigint): Promise<bigint> { return this.client.getBalance({ address, blockNumber: block }); }
  async proposal(governor: Address, id: bigint, block: bigint) {
    const proposal=await this.client.readContract({address:governor,abi:totalsAbi,functionName:'getProposal',args:[id],blockNumber:block});
    return {yes:proposal.yes,no:proposal.no,abstain:proposal.abstain,executed:proposal.executed};
  }
  async isCitizen(registry: Address, address: Address): Promise<boolean> { return this.client.readContract({ address: registry, abi: totalsAbi, functionName: 'isCitizen', args: [address] }); }
  async verifyMessage(address: Address, message: string, signature: Hex): Promise<boolean> { return this.client.verifyMessage({address,message,signature}); }
  async identity(): Promise<number> { return this.client.getChainId(); }
}
