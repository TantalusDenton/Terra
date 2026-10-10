import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { LedgerStore, StaticShardRouter } from '../src/store.js';
import { databaseUrl } from '../src/config.js';

const schema=`terra_benchmark_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString:databaseUrl,max:1});
const key='31337:0x0000000000000000000000000000000000000001';
let store:LedgerStore|undefined;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:2,statement_timeout:600000});
  store=new LedgerStore(new StaticShardRouter(new Map([['local',pool]]))); await store.migrate();
  const loadStart=performance.now();
  await pool.query(`INSERT INTO community_state(community_key,community_id,source_block,source_hash,source_timestamp,finality,head_block,members,proposal_count)
    VALUES($1,'terra',100,'0x01',100,'latest',100,10000000001,1000000)`,[key]);
  await pool.query(`INSERT INTO proposals(community_key,proposal_id,title,summary,proposer,starts_at,ends_at,electorate,policy_hash,actions_hash,action_count,content_hash,creation_tx,creation_block)
    SELECT $1,n,'Synthetic proposal '||n,'Synthetic benchmark metadata only','0x0000000000000000000000000000000000000001',1,999999,10000000001,'0x01','0x02',0,'0x03','0x04',1 FROM generate_series(1,1000000) n`,[key]);
  await pool.query('ANALYZE proposals');
  const loadMs=performance.now()-loadStart;
  const durations:number[]=[]; let before:string|undefined; let ceiling:string|undefined; let maximumRecords=0;
  for (let i=0;i<100;i++) {
    const started=performance.now();
    const page=await store.proposalPage(key,20,before,ceiling,'100');
    durations.push(performance.now()-started); maximumRecords=Math.max(maximumRecords,page.items.length);
    before=page.items.at(-1)!.id; ceiling=page.ceiling;
    if (page.items.length!==20 || page.items.some(item=>'body' in item || 'actions' in item)) throw new Error('Bounded lazy-page invariant failed');
  }
  const explain=await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT proposal_id,title,summary FROM proposals WHERE community_key=$1 AND proposal_id<900000 ORDER BY proposal_id DESC LIMIT 20`,[key]);
  const summary=await store.summary(key);
  if (summary!.counts.members!=='10000000001') throw new Error('Billion population precision failed');
  const ordered=[...durations].sort((a,b)=>a-b);
  const result={fixture:'synthetic PostgreSQL indexed metadata; not chain capacity',postgresVersion:(await pool.query('SHOW server_version')).rows[0].server_version,proposalRecords:1000000,simulatedMembers:summary!.counts.members,loadMs,requests:100,pageSize:20,maxRecordsReturned:maximumRecords,queriesPerPage:{first:2,continuation:1},rpcCallsPerProposalPage:0,p50Ms:ordered[50],p95Ms:ordered[95],p99Ms:ordered[99],queryPlan:explain.rows[0]['QUERY PLAN'],measuredAt:new Date().toISOString()};
  await writeFile('benchmark-result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,queryPlan:undefined},null,2));
} finally {
  if (store) await store.close();
  if (/^terra_benchmark_[0-9a-f]{32}$/.test(schema)) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
