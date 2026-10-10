import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Community, IndexedEvent, ProposalCard, Source } from './types.js';
import { json } from './types.js';

export interface ShardRouter {
  route(communityKey: string): Pool;
  all(): Pool[];
}
/** Explicit consistent routing hook; deploying another shard does not implicitly move communities. */
export class StaticShardRouter implements ShardRouter {
  private assignments: Map<string, string>;
  constructor(private shards: Map<string, Pool>, assignments: Record<string, string> = {}, private defaultShard = 'local') {
    this.assignments = new Map(Object.entries(assignments));
    if (!shards.has(defaultShard)) throw new Error('Default shard is missing');
    for (const shard of this.assignments.values()) if (!shards.has(shard)) throw new Error(`Unknown shard ${shard}`);
  }
  route(key: string): Pool { return this.shards.get(this.assignments.get(key) ?? this.defaultShard)!; }
  all(): Pool[] { return [...this.shards.values()]; }
}
export interface Checkpoint {
  communityKey: string; communityId: string; blockNumber: string; blockHash: string;
  timestamp: string; archiveHash: string; members: string; proposalCount: string;
  headBlockNumber: string; finality: Community['finality'];
}
type Row = QueryResultRow & Record<string, unknown>;
export type ProposalFilter = '' | 'Active' | 'Defeated' | 'Passed' | 'Executed' | 'Results';
export function proposalState(row: { [key: string]: unknown }, timestamp: string): ProposalCard['state'] {
  if (row.executed === true) return 'Executed';
  if (BigInt(String(row.ends_at)) > BigInt(timestamp)) return 'Active';
  return BigInt(String(row.yes)) > BigInt(String(row.no)) ? 'Passed' : 'Defeated';
}
function card(row: Row, timestamp: string): ProposalCard {
  return {
    id: String(row.proposal_id), title: String(row.title), summary: String(row.summary),
    proposer: row.proposer as ProposalCard['proposer'], startsAt: String(row.starts_at), endsAt: String(row.ends_at),
    electorate: String(row.electorate), yes: String(row.yes), no: String(row.no), abstain: String(row.abstain),
    executed: row.executed === true, policyHash: row.policy_hash as ProposalCard['policyHash'],
    actionsHash: row.actions_hash as ProposalCard['actionsHash'], actionCount: Number(row.action_count),
    creationTx: row.creation_tx as ProposalCard['creationTx'], creationBlock: String(row.creation_block),
    state: proposalState(row, timestamp),
  };
}
export class LedgerStore {
  constructor(readonly router: ShardRouter) {}
  async migrate(): Promise<void> {
    const sql = await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8');
    for (const pool of this.router.all()) {
      const connection=await pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query("SET LOCAL statement_timeout='120s'");
        await connection.query(sql);
        await connection.query('COMMIT');
      } catch (error) { await connection.query('ROLLBACK'); throw error; }
      finally { connection.release(); }
    }
  }
  async close(): Promise<void> { await Promise.all(this.router.all().map(pool => pool.end())); }
  async health(): Promise<void> { await Promise.all(this.router.all().map(pool => pool.query('SELECT 1'))); }
  async getCheckpoint(key: string): Promise<Checkpoint | undefined> {
    const result = await this.router.route(key).query(`SELECT c.*, s.community_id, s.head_block, s.finality FROM checkpoints c
      JOIN community_state s USING (community_key) WHERE c.community_key=$1 ORDER BY c.block_number DESC LIMIT 1`, [key]);
    const row = result.rows[0] as Row | undefined;
    return row ? this.checkpointRow(row) : undefined;
  }
  private checkpointRow(row: Row): Checkpoint {
    return { communityKey: String(row.community_key), communityId: String(row.community_id), blockNumber: String(row.block_number),
      blockHash: String(row.block_hash), timestamp: String(row.block_timestamp), archiveHash: String(row.archive_hash),
      members: String(row.members), proposalCount: String(row.proposal_count), headBlockNumber: String(row.head_block), finality: row.finality as Community['finality'] };
  }
  async previousCheckpoints(key: string, before: string, limit = 64): Promise<Checkpoint[]> {
    const result = await this.router.route(key).query(`SELECT c.*, s.community_id,s.head_block,s.finality FROM checkpoints c
      JOIN community_state s USING (community_key) WHERE c.community_key=$1 AND c.block_number<$2 ORDER BY c.block_number DESC LIMIT $3`, [key, before, limit]);
    return result.rows.map(row => this.checkpointRow(row));
  }
  async summary(key: string): Promise<{ source: Source; counts: { members: string; proposals: string }; error?: string } | undefined> {
    const result = await this.router.route(key).query('SELECT * FROM community_state WHERE community_key=$1', [key]);
    const row = result.rows[0] as Row | undefined;
    if (!row || row.source_block === null) return undefined;
    const source = {
      blockNumber: String(row.source_block), blockHash: row.source_hash as Source['blockHash'], timestamp: String(row.source_timestamp),
      finality: row.finality as Source['finality'], indexingLag: (BigInt(String(row.head_block)) > BigInt(String(row.source_block)) ? BigInt(String(row.head_block)) - BigInt(String(row.source_block)) : 0n).toString(),
      headBlockNumber: String(row.head_block), updatedAt: (row.updated_at as Date).toISOString(),
    };
    return { source, counts: { members: String(row.members), proposals: String(row.proposal_count) }, ...(row.last_error ? { error: String(row.last_error) } : {}) };
  }
  async setError(key: string, communityId: string, error: string): Promise<void> {
    await this.router.route(key).query(`INSERT INTO community_state(community_key,community_id,last_error) VALUES($1,$2,$3)
      ON CONFLICT(community_key) DO UPDATE SET last_error=$3`, [key, communityId, error.slice(0, 500)]);
  }
  async updateHead(key: string, head: string): Promise<void> {
    await this.router.route(key).query('UPDATE community_state SET head_block=$2,last_error=NULL WHERE community_key=$1', [key, head]);
  }
  /** The log, its derived mutation, archive pointer, and checkpoint commit together. */
  async commit(events: IndexedEvent[], checkpoint: Checkpoint, authoritative?: Map<string,{yes:bigint;no:bigint;abstain:bigint;executed:boolean}>): Promise<void> {
    const connection = await this.router.route(checkpoint.communityKey).connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [checkpoint.communityKey]);
      const latest=await connection.query('SELECT source_block,source_hash FROM community_state WHERE community_key=$1',[checkpoint.communityKey]);
      if (latest.rows[0]?.source_block!==null && latest.rows[0]?.source_block!==undefined && BigInt(latest.rows[0].source_block)>BigInt(checkpoint.blockNumber)) throw new Error('An overlapping index worker advanced this community; retry from its checkpoint');
      if (latest.rows[0]?.source_block===checkpoint.blockNumber && latest.rows[0]?.source_hash!==checkpoint.blockHash) throw new Error('A changed canonical source requires explicit reorganization recovery');
      for (const event of events) {
        if (event.communityKey !== checkpoint.communityKey) throw new Error('Cross-community event batch');
        const inserted = await connection.query(`INSERT INTO canonical_events(community_key,block_number,block_hash,transaction_hash,log_index,event_type,proposal_id,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING log_index`, [event.communityKey,event.blockNumber,event.blockHash,event.transactionHash,event.logIndex,event.type,event.proposalId,json(event.payload)]);
        if (!inserted.rowCount) continue;
        await this.apply(connection, event);
      }
      if (authoritative) for (const [id, expected] of authoritative) {
        const result=await connection.query('SELECT yes,no,abstain,executed FROM proposals WHERE community_key=$1 AND proposal_id=$2',[checkpoint.communityKey,id]);
        const row=result.rows[0];
        if (!row || BigInt(row.yes)!==expected.yes || BigInt(row.no)!==expected.no || BigInt(row.abstain)!==expected.abstain || row.executed!==expected.executed) throw new Error(`Canonical event tallies disagree with pinned contract state for proposal ${id}`);
      }
      await connection.query(`INSERT INTO checkpoints(community_key,block_number,block_hash,block_timestamp,archive_hash,members,proposal_count)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (community_key,block_number) DO UPDATE SET block_hash=$3,block_timestamp=$4,archive_hash=$5,members=$6,proposal_count=$7`,
        [checkpoint.communityKey,checkpoint.blockNumber,checkpoint.blockHash,checkpoint.timestamp,checkpoint.archiveHash,checkpoint.members,checkpoint.proposalCount]);
      await connection.query(`INSERT INTO community_state(community_key,community_id,source_block,source_hash,source_timestamp,finality,head_block,members,proposal_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(community_key) DO UPDATE SET
        community_id=$2,source_block=$3,source_hash=$4,source_timestamp=$5,finality=$6,head_block=$7,members=$8,proposal_count=$9,updated_at=now(),last_error=NULL`,
        [checkpoint.communityKey,checkpoint.communityId,checkpoint.blockNumber,checkpoint.blockHash,checkpoint.timestamp,checkpoint.finality,checkpoint.headBlockNumber,checkpoint.members,checkpoint.proposalCount]);
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  private async apply(connection: PoolClient, event: IndexedEvent): Promise<void> {
    const p = event.payload;
    if (event.type === 'ProposalCreated') {
      await connection.query(`INSERT INTO proposals(community_key,proposal_id,title,summary,proposer,starts_at,ends_at,electorate,policy_hash,actions_hash,action_count,content_hash,creation_tx,creation_block)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [event.communityKey,event.proposalId,p.title,p.summary,p.proposer,p.startsAt,p.endsAt,p.electorate,p.policyHash,p.actionsHash,p.actionCount,p.contentHash,event.transactionHash,event.blockNumber]);
    } else if (event.type === 'VoteCast') {
      const column = p.choice === 0 ? 'no' : p.choice === 1 ? 'yes' : p.choice === 2 ? 'abstain' : undefined;
      if (!column) throw new Error('Invalid canonical ballot choice');
      const result = await connection.query(`UPDATE proposals SET ${column}=${column}+1 WHERE community_key=$1 AND proposal_id=$2`, [event.communityKey,event.proposalId]);
      if (!result.rowCount) throw new Error('Vote references a proposal not yet indexed');
    } else {
      const result = await connection.query('UPDATE proposals SET executed=true WHERE community_key=$1 AND proposal_id=$2', [event.communityKey,event.proposalId]);
      if (!result.rowCount) throw new Error('Execution references a proposal not yet indexed');
    }
  }
  async rollback(key: string, ancestor?: Checkpoint): Promise<void> {
    const connection = await this.router.route(key).connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      if (!ancestor) {
        for (const table of ['proposals','canonical_events','checkpoints','community_state']) await connection.query(`DELETE FROM ${table} WHERE community_key=$1`, [key]);
      } else {
        // Set-based rewind touches only proposals referenced by orphaned events, never all ballots/members.
        await connection.query(`CREATE TEMP TABLE rewind_deltas ON COMMIT DROP AS SELECT proposal_id,
          count(*) FILTER (WHERE event_type='VoteCast' AND payload->>'choice'='1') AS yes_delta,
          count(*) FILTER (WHERE event_type='VoteCast' AND payload->>'choice'='0') AS no_delta,
          count(*) FILTER (WHERE event_type='VoteCast' AND payload->>'choice'='2') AS abstain_delta,
          count(*) FILTER (WHERE event_type='PolicyEnacted') AS execution_delta
          FROM canonical_events WHERE community_key=$1 AND block_number>$2 GROUP BY proposal_id`, [key,ancestor.blockNumber]);
        await connection.query('DELETE FROM proposals WHERE community_key=$1 AND creation_block>$2', [key,ancestor.blockNumber]);
        await connection.query('DELETE FROM canonical_events WHERE community_key=$1 AND block_number>$2', [key,ancestor.blockNumber]);
        await connection.query(`UPDATE proposals p SET yes=p.yes-d.yes_delta,no=p.no-d.no_delta,abstain=p.abstain-d.abstain_delta,
          executed=CASE WHEN d.execution_delta>0 THEN false ELSE p.executed END FROM rewind_deltas d
          WHERE p.community_key=$1 AND p.proposal_id=d.proposal_id`, [key]);
        await connection.query('DELETE FROM checkpoints WHERE community_key=$1 AND block_number>$2', [key,ancestor.blockNumber]);
        await connection.query(`UPDATE community_state SET source_block=$2,source_hash=$3,source_timestamp=$4,members=$5,proposal_count=$6,updated_at=now(),last_error=NULL WHERE community_key=$1`,
          [key,ancestor.blockNumber,ancestor.blockHash,ancestor.timestamp,ancestor.members,ancestor.proposalCount]);
      }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  async proposalPage(key: string, limit: number, before: string | undefined, ceiling: string | undefined, timestamp: string, state: ProposalFilter = ''): Promise<{ items: ProposalCard[]; ceiling: string }> {
    const pool = this.router.route(key);
    let upper = ceiling;
    if (upper === undefined) {
      const result = await pool.query('SELECT proposal_count FROM community_state WHERE community_key=$1', [key]);
      upper = String(result.rows[0]?.proposal_count ?? '0');
    }
    const filter = state === 'Results' ? 'AND (executed OR ends_at<=$4)' : state === 'Executed' ? 'AND executed' : state === 'Active' ? 'AND NOT executed AND ends_at>$4' :
      state === 'Passed' ? 'AND NOT executed AND ends_at<=$4 AND yes>no' : state === 'Defeated' ? 'AND NOT executed AND ends_at<=$4 AND yes<=no' : '';
    const result = await pool.query(`SELECT * FROM proposals WHERE community_key=$1 AND proposal_id<=$2 AND proposal_id<$3 AND $4::numeric>=0 ${filter} ORDER BY proposal_id DESC LIMIT $5`,
      [key,upper,before ?? (BigInt(upper)+1n).toString(),timestamp,limit]);
    return { items: result.rows.map(row => card(row,timestamp)), ceiling: upper };
  }
  async proposal(key: string, id: string, timestamp: string): Promise<{ card: ProposalCard; contentHash: string } | undefined> {
    const result = await this.router.route(key).query('SELECT * FROM proposals WHERE community_key=$1 AND proposal_id=$2', [key,id]);
    return result.rows[0] ? { card: card(result.rows[0],timestamp), contentHash: result.rows[0].content_hash } : undefined;
  }
}
