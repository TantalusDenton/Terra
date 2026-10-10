import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters, verifyMessage, type Address, type Hex, type Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import sharp from 'sharp';
import { LedgerStore, StaticShardRouter, type Checkpoint } from '../src/store.js';
import { FileObjectStorage } from '../src/objects.js';
import { CommunityIndexer } from '../src/indexer.js';
import { type ChainRpc, type ChainBlock, governanceEvents } from '../src/rpc.js';
import { normalizeCommunity, getDatabaseUrl } from '../src/config.js';
import { communityKey, type IndexedEvent } from '../src/types.js';
import { createApi, logoMessage } from '../src/api.js';
import { CursorCodec } from '../src/cursor.js';

const schema=`terra_test_${randomUUID().replaceAll('-','')}`;
const databaseUrl=getDatabaseUrl();
const admin=new Pool({connectionString:databaseUrl,max:1});
let store: LedgerStore; let pool: Pool; let directory: string; let objects: FileObjectStorage;
const address='0x0000000000000000000000000000000000000001' as Address;
const registry='0x0000000000000000000000000000000000000002' as Address;
const community=normalizeCommunity({id:'terra',chainId:'31337',rpcUrl:'http://127.0.0.1:8545',governor:address,registry,deploymentBlock:'1'});
const hash=(text:string):Hex=>keccak256(Buffer.from(text));

before(async()=> {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:3});
  store=new LedgerStore(new StaticShardRouter(new Map([['local',pool]])));
  await store.migrate(); directory=await mkdtemp(resolve(tmpdir(),'terra-pg-test-')); objects=new FileObjectStorage(directory);
});
after(async()=> {
  if (store) await store.close();
  // Only this test-created schema is removed; production rows and volumes are preserved.
  if (/^terra_test_[0-9a-f]{32}$/.test(schema)) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end(); if (directory) await rm(directory,{recursive:true,force:true});
});
function checkpoint(key:string,block:number,members='10000000001',proposalCount='30'):Checkpoint {
  return {communityKey:key,communityId:'terra',blockNumber:String(block),blockHash:hash(`block${block}`),timestamp:String(block*100),archiveHash:hash('archive'),members,proposalCount,headBlockNumber:String(block+1),finality:'latest'};
}
function creation(key:string,id:number,block:number):IndexedEvent {
  return {communityKey:key,blockNumber:String(block),blockHash:hash(`block${block}`),transactionHash:hash(`tx${key}${id}`),logIndex:0,type:'ProposalCreated',proposalId:String(id),payload:{title:`Proposal ${id}`,summary:'summary',proposer:address,startsAt:'100',endsAt:'3700',electorate:'10000000001',policyHash:hash('policy'),actionsHash:hash('actions'),actionCount:0,contentHash:hash('content')}};
}
function vote(key:string,id:number,block:number,choice:number):IndexedEvent {
  return {communityKey:key,blockNumber:String(block),blockHash:hash(`block${block}`),transactionHash:hash(`vote${key}${id}${block}${choice}`),logIndex:0,type:'VoteCast',proposalId:String(id),payload:{choice}};
}

test('real PostgreSQL atomically indexes, deduplicates, pages, and isolates chain/governor identities',async()=> {
  const key=communityKey(community); const other=`31338:${address}`;
  const events=Array.from({length:30},(_,i)=>creation(key,i+1,1));
  const ballot=vote(key,30,1,1); events.push(ballot);
  await store.commit(events,checkpoint(key,1)); await store.commit(events,checkpoint(key,1));
  await store.commit([creation(other,1,1)],checkpoint(other,1,'1','1'));
  assert.equal((await store.summary(key))!.counts.members,'10000000001');
  assert.equal((await store.proposal(key,'30','100'))!.card.yes,'1');
  assert.equal((await store.proposal(other,'1','100'))!.card.yes,'0');
  const first=await store.proposalPage(key,20,undefined,undefined,'100');
  assert.equal(first.items.length,20); assert.equal(first.items[0].id,'30'); assert.equal(first.items[19].id,'11');
  // A new record between requests does not move the original page ceiling.
  await store.commit([creation(key,31,2)],checkpoint(key,2,'10000000001','31'));
  const next=await store.proposalPage(key,20,'11',first.ceiling,'100');
  assert.deepEqual(next.items.map(item=>item.id),Array.from({length:10},(_,i)=>String(10-i)));
  assert.equal('body' in first.items[0],false); assert.equal('actions' in first.items[0],false);
  const result=await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname=$1 AND (tablename LIKE 'proposals_%' OR tablename LIKE 'canonical_events_%')",[schema]);
  assert.equal(result.rows[0].count,'32');
});

test('reorg rollback removes orphaned creations, votes and executions without altering another chain',async()=> {
  const key=communityKey(community); const anchor=(await store.previousCheckpoints(key,'2',1))[0];
  const enacted:IndexedEvent={...vote(key,30,3,1),transactionHash:hash('execute'),type:'PolicyEnacted',payload:{policyHash:hash('policy')}};
  await store.commit([vote(key,30,3,0),enacted],checkpoint(key,3,'10000000002','31'));
  assert.equal((await store.proposal(key,'30','100'))!.card.executed,true);
  await store.rollback(key,anchor);
  assert.equal(await store.proposal(key,'31','100'),undefined);
  const old=(await store.proposal(key,'30','100'))!.card;
  assert.equal(old.yes,'1'); assert.equal(old.no,'0'); assert.equal(old.executed,false);
  assert.equal((await store.summary(key))!.counts.members,'10000000001');
  assert.equal((await store.summary(`31338:${address}`))!.counts.members,'1');
});

class FixtureChain implements ChainRpc {
  chainId=31339;
  blocks=new Map<bigint,ChainBlock>();
  records:Log[]=[];
  outage=false;
  citizen=true;
  constructor() { for (let number=1n;number<=3n;number++) this.blocks.set(number,{number,hash:hash(`fixture${number}`),timestamp:100n+number}); }
  async identity():Promise<number> { return this.chainId; }
  async head():Promise<ChainBlock> { return this.blocks.get(3n)!; }
  async target():Promise<ChainBlock> { return this.head(); }
  async block(number:bigint):Promise<ChainBlock> { if (this.outage) throw new Error('RPC unavailable'); return this.blocks.get(number)!; }
  async logs(_address:Address,from:bigint,to:bigint):Promise<Log[]> { return this.records.filter(log=>log.blockNumber!>=from && log.blockNumber!<=to); }
  async totals(_governor:Address,_registry:Address,block:bigint) { return {members:10_000_000_001n,proposals:block>=2n?1n:0n}; }
  async balance():Promise<bigint> { return 1234n; }
  async proposal(_governor:Address,_id:bigint,block:bigint) {
    const votes=this.records.filter(log=>log.blockNumber!<=block && log.blockNumber===3n);
    const choices=votes.map(log=>Number(BigInt(`0x${log.data.slice(2,66)}`)));
    return {yes:BigInt(choices.filter(choice=>choice===1).length),no:BigInt(choices.filter(choice=>choice===0).length),abstain:BigInt(choices.filter(choice=>choice===2).length),executed:false};
  }
  async isCitizen():Promise<boolean> { return this.citizen; }
  async verifyMessage(address:Address,message:string,signature:Hex):Promise<boolean> { return verifyMessage({address,message,signature}); }
  create():Log {
    const title='Recorded policy';const summary='Read only card';const body='<script>escaped policy</script>';
    const policyHash=keccak256(encodeAbiParameters(parseAbiParameters('string,string,string'),[title,summary,body]));
    const actionsHash=keccak256(encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes data)[]'),[[]]));
    return {address,data:encodeAbiParameters(parseAbiParameters('string,string,string,uint64,uint256,(address target,uint256 value,bytes data)[],bytes32,bytes32'),[title,summary,body,3702n,10_000_000_001n,[],policyHash,actionsHash]),topics:encodeEventTopics({abi:governanceEvents,eventName:'ProposalCreated',args:{proposalId:1n,proposer:address}}) as Log['topics'],blockNumber:2n,blockHash:this.blocks.get(2n)!.hash,transactionHash:hash('fixturecreate'),transactionIndex:0,logIndex:0,removed:false};
  }
  vote(choice:number):Log {
    return {address,data:encodeAbiParameters(parseAbiParameters('uint8,uint256'),[choice,1n]),topics:encodeEventTopics({abi:governanceEvents,eventName:'VoteCast',args:{proposalId:1n,voter:registry}}) as Log['topics'],blockNumber:3n,blockHash:this.blocks.get(3n)!.hash,transactionHash:hash(`fixturevote${choice}`),transactionIndex:0,logIndex:0,removed:false};
  }
}

test('incremental index resumes checkpoints, recovers reorgs, keeps records on RPC outage, and lazy HTTP returns verified content',async()=> {
  const chain=new FixtureChain(); const indexedCommunity=normalizeCommunity({...community,chainId:'31339'}); const key=communityKey(indexedCommunity);
  chain.records=[chain.create(),chain.vote(1)];
  const indexer=new CommunityIndexer(store,objects,1n);
  await indexer.tick(indexedCommunity,chain);
  assert.equal((await store.proposal(key,'1','103'))!.card.yes,'1');
  // Process restart uses the same committed database checkpoint and does not duplicate events.
  await new CommunityIndexer(store,objects,1n).tick(indexedCommunity,chain);
  assert.equal((await store.proposal(key,'1','103'))!.card.yes,'1');
  chain.outage=true; await assert.rejects(indexer.tick(indexedCommunity,chain),/RPC unavailable/);
  assert.equal((await store.proposal(key,'1','103'))!.card.yes,'1');
  chain.outage=false;
  chain.blocks.set(3n,{number:3n,hash:hash('replacement3'),timestamp:103n}); chain.records=[chain.create(),chain.vote(0)];
  await indexer.tick(indexedCommunity,chain);
  const replacement=(await store.proposal(key,'1','103'))!.card;
  assert.equal(replacement.yes,'0'); assert.equal(replacement.no,'1');
  const api=createApi({store,objects,communities:async()=>[indexedCommunity],rpc:()=>chain,cursor:new CursorCodec('test-secret-at-least-twentyfour-characters'),objectBaseUrl:'http://127.0.0.1/v1',allowedOrigins:new Set()});
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
  try {
    const port=(api.address() as {port:number}).port;
    const base=`http://127.0.0.1:${port}/v1`;
    chain.outage=true;
    const deployment=await (await fetch(`${base}/communities/terra/deployment`)).json();
    assert.equal(deployment.community.chainId,indexedCommunity.chainId);
    assert.match(deployment.trustAssumption,/not a cryptographic proof/);
    chain.outage=false;
    const summary=await (await fetch(`${base}/communities/terra`)).json();
    assert.equal(summary.treasuryBalanceWei,'1234'); assert.equal(summary.source.timestamp,'103'); assert.equal(summary.counts.members,'10000000001');
    const page=await (await fetch(`${base}/communities/terra/proposals`)).json();
    assert.equal(page.items.length,1); assert.equal('body' in page.items[0],false);
    assert.equal((await (await fetch(`${base}/communities/terra/proposals?state=Results`)).json()).items.length,0);
    const detail=await (await fetch(`${base}/communities/terra/proposals/1`)).json();
    assert.equal(detail.proposal.body,'<script>escaped policy</script>'); assert.deepEqual(detail.proposal.actions,[]);
    assert.equal((await fetch(`${base}/communities/terra/proposals?limit=101`)).status,400);
    assert.equal((await fetch(`${base}/communities/terra/proposals`,{headers:{origin:'https://untrusted.invalid'}})).status,403);
    assert.equal((await fetch(`${base}/logos`,{method:'POST',body:Buffer.from('invalid')})).status,401);
    const signer=privateKeyToAccount(hash('fixture-logo-signing-account'));
    const logo=await sharp({create:{width:12,height:12,channels:3,background:'#064B8E'}}).png().toBuffer();
    const logoHash=keccak256(logo);
    const issued=String(Math.floor(Date.now()/1000));
    const message=logoMessage(indexedCommunity,signer.address,logoHash,issued);
    const signature=await signer.signMessage({message});
    const headers={'x-terra-wallet':signer.address,'x-terra-signature':signature,'x-terra-message':Buffer.from(message).toString('base64url'),'content-type':'image/jpeg'};
    const upload=await fetch(`${base}/logos`,{method:'POST',headers,body:logo});
    assert.equal(upload.status,201); const uploaded=await upload.json();
    assert.equal(uploaded.mime,'image/png'); assert.equal(uploaded.hash,logoHash);
    assert.deepEqual((await objects.get(logoHash)).bytes,logo);
    assert.equal((await fetch(`${base}/logos`,{method:'POST',headers,body:Buffer.from('modified bytes')})).status,401);
    chain.citizen=false;
    assert.equal((await fetch(`${base}/logos`,{method:'POST',headers,body:logo})).status,403); chain.citizen=true;
    const expired=logoMessage(indexedCommunity,signer.address,logoHash,String(Number(issued)-301));
    const oldHeaders={...headers,'x-terra-message':Buffer.from(expired).toString('base64url'),'x-terra-signature':await signer.signMessage({message:expired})};
    assert.equal((await fetch(`${base}/logos`,{method:'POST',headers:oldHeaders,body:logo})).status,401);
  } finally { await new Promise<void>(resolve=>api.close(()=>resolve())); }
});
