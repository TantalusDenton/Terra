import { decodeEventLog, encodeAbiParameters, keccak256, parseAbiParameters, type Log, type Hex } from 'viem';
import { governanceEvents, type ChainBlock, type ChainRpc } from './rpc.js';
import { type Community, communityKey, type IndexedEvent, type Action, json } from './types.js';
import type { LedgerStore, Checkpoint } from './store.js';
import type { ObjectStorage } from './objects.js';

/** Each chain gets at most one pending task; concurrency and ranges are bounded globally. */
export class BoundedChainQueue {
  private pending = new Map<string, () => Promise<void>>();
  private running = new Set<string>();
  constructor(private concurrency = 2, private capacity = 128) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Indexer concurrency must be an integer between 1 and 16');
    if (!Number.isInteger(capacity) || capacity < concurrency || capacity > 1024) throw new Error('Indexer queue capacity must be an integer between concurrency and 1024');
  }
  enqueue(key: string, work: () => Promise<void>): boolean {
    if (this.pending.has(key) || this.running.has(key)) return false;
    if (this.pending.size + this.running.size >= this.capacity) return false;
    this.pending.set(key, work);
    this.drain();
    return true;
  }
  get size(): number { return this.pending.size + this.running.size; }
  private drain(): void {
    while (this.running.size < this.concurrency && this.pending.size) {
      const [key, work] = this.pending.entries().next().value!;
      this.pending.delete(key); this.running.add(key);
      void Promise.resolve().then(work).catch(() => { /* Worker records failure; other chains remain runnable. */ }).finally(() => { this.running.delete(key); this.drain(); });
    }
  }
}

/** Slow manifest reads cannot stack interval invocations or duplicate admission scans. */
export class SingleFlightPoller {
  private current?: Promise<void>;
  constructor(private work: () => Promise<void>) {}
  tick(): Promise<void> {
    if (this.current) return this.current;
    const pending = Promise.resolve().then(this.work).finally(() => {
      if (this.current === pending) this.current = undefined;
    });
    this.current = pending;
    return pending;
  }
}

export class CommunityIndexer {
  constructor(private store: LedgerStore, private objects: ObjectStorage, private maxRange = 500n, private maxLogs = 5000, private maxBatches = 4) {
    if (typeof maxRange !== 'bigint' || maxRange < 1n || maxRange > 5000n) throw new Error('Indexer block range must be between 1 and 5000');
    if (!Number.isInteger(maxLogs) || maxLogs < 1 || maxLogs > 10000) throw new Error('Indexer event bound must be an integer between 1 and 10000');
    if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 16) throw new Error('Indexer batches must be an integer between 1 and 16');
  }
  async tick(community: Community, rpc: ChainRpc): Promise<void> {
    if (community.status !== 'Active' || !community.governor || !community.registry) return;
    const key = communityKey(community);
    try {
      if (BigInt(await rpc.identity()) !== BigInt(community.chainId)) throw new Error('RPC chain identity does not match the governance manifest');
      const [head,target] = await Promise.all([rpc.head(),rpc.target(community.finality)]);
      if (target.number > head.number) throw new Error('Finality block exceeds latest head');
      let checkpoint = await this.store.getCheckpoint(key);
      if (checkpoint && !(await this.canonical(checkpoint,rpc,head.number))) {
        let ancestor: Checkpoint | undefined;
        let before = checkpoint.blockNumber;
        // Search at most 64 anchors; a deeper rewrite resets derived data and starts a bounded rebuild.
        for (const candidate of await this.store.previousCheckpoints(key,before,64)) {
          if (await this.canonical(candidate,rpc,head.number)) { ancestor = candidate; break; }
          before = candidate.blockNumber;
        }
        await this.store.rollback(key,ancestor);
        checkpoint = ancestor;
      }
      let from = checkpoint ? BigInt(checkpoint.blockNumber)+1n : BigInt(community.deploymentBlock);
      for (let batch = 0; batch < this.maxBatches && from <= target.number; batch++) {
        let to = from + this.maxRange - 1n < target.number ? from + this.maxRange - 1n : target.number;
        let logs: Log[];
        while (true) {
          try { logs = await rpc.logs(community.governor,from,to); }
          catch (error) {
            if (from === to) throw error;
            to = from + (to-from)/2n; continue;
          }
          if (logs.length <= this.maxLogs) break;
          if (from === to) throw new Error(`One block exceeds the bounded ${this.maxLogs}-event ingestion limit; configure a larger per-block bound`);
          to = from + (to-from)/2n;
        }
        const end = await rpc.block(to);
        const eventBlocks = new Map<string,ChainBlock>();
        const events: IndexedEvent[] = [];
        logs.sort((a,b) => a.blockNumber! < b.blockNumber! ? -1 : a.blockNumber! > b.blockNumber! ? 1 : a.logIndex!-b.logIndex!);
        for (const log of logs) {
          if (log.removed || log.blockNumber === null || !log.blockHash || !log.transactionHash || log.logIndex === null) throw new Error('Incomplete or removed event cannot enter canonical index');
          if (log.blockNumber < from || log.blockNumber > to) throw new Error('RPC returned a log outside the requested range');
          let block = eventBlocks.get(log.blockNumber.toString());
          if (!block) { block = await rpc.block(log.blockNumber); eventBlocks.set(log.blockNumber.toString(),block); }
          if (block.hash !== log.blockHash) throw new Error('Chain reorganized during log ingestion');
          const event = await this.decode(key,log,block);
          if (event) events.push(event);
        }
        const totals = await rpc.totals(community.governor,community.registry,to);
        const authoritative=new Map<string,{yes:bigint;no:bigint;abstain:bigint;executed:boolean}>();
        // Validate only changed proposals; population size never increases read work.
        const changed=[...new Set(events.map(event=>event.proposalId))];
        for (let offset=0;offset<changed.length;offset+=4) await Promise.all(changed.slice(offset,offset+4).map(async id=> {
          authoritative.set(id,await rpc.proposal(community.governor!,BigInt(id),to));
        }));
        // Recheck the boundary after all RPC reads; commit cannot mix histories.
        if ((await rpc.block(to)).hash !== end.hash) throw new Error('Chain reorganized during checkpoint reads');
        const archiveHash = await this.objects.put(Buffer.from(json({ version: 1,communityKey:key,fromBlock:from,toBlock:to,blockHash:end.hash,logs })), 'application/json');
        await this.store.commit(events,{communityKey:key,communityId:community.id,blockNumber:to.toString(),blockHash:end.hash,timestamp:end.timestamp.toString(),archiveHash,members:totals.members.toString(),proposalCount:totals.proposals.toString(),headBlockNumber:head.number.toString(),finality:community.finality},authoritative);
        from = to+1n;
      }
      await this.store.updateHead(key,head.number.toString());
    } catch (error) {
      await this.store.setError(key,community.id,error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  private async canonical(checkpoint: Checkpoint, rpc: ChainRpc, head: bigint): Promise<boolean> {
    if (BigInt(checkpoint.blockNumber)>head) return false;
    // RPC outages must leave all persisted canonical history intact.
    return (await rpc.block(BigInt(checkpoint.blockNumber))).hash === checkpoint.blockHash;
  }
  private async decode(key: string, log: Log, block: ChainBlock): Promise<IndexedEvent | undefined> {
    const decoded = decodeEventLog({ abi: governanceEvents,data:log.data,topics:log.topics,strict:true });
    const args = decoded.args;
    const base = { communityKey:key,blockNumber:block.number.toString(),blockHash:block.hash,transactionHash:log.transactionHash!,logIndex:log.logIndex!,proposalId:args.proposalId.toString() };
    if (decoded.eventName === 'ProposalCreated') {
      const args = decoded.args;
      const actions: Action[] = args.actions.map(action => ({target:action.target,value:action.value.toString(),data:action.data}));
      const policyHash = keccak256(encodeAbiParameters(parseAbiParameters('string,string,string'),[args.title,args.summary,args.body]));
      const actionsHash = keccak256(encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes data)[]'),[args.actions]));
      if (policyHash !== args.policyHash || actionsHash !== args.actionsHash) throw new Error('Proposal event payload hashes do not match');
      const contentHash = await this.objects.put(Buffer.from(json({body:args.body,actions})), 'application/json');
      return {...base,type:'ProposalCreated',payload:{title:args.title,summary:args.summary,proposer:args.proposer,startsAt:block.timestamp.toString(),endsAt:args.endsAt.toString(),electorate:args.electorate.toString(),policyHash,actionsHash,actionCount:actions.length,contentHash}};
    }
    if (decoded.eventName === 'VoteCast') {
      if (decoded.args.weight !== 1n) throw new Error('Nonunit vote weight violates equal governance');
      return {...base,type:'VoteCast',payload:{choice:decoded.args.choice}};
    }
    if (decoded.eventName === 'PolicyEnacted') return {...base,type:'PolicyEnacted',payload:{policyHash:decoded.args.policyHash}};
    return undefined;
  }
}
