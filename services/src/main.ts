import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { databaseUrl, runtimePath, loadManifest, loadProtocol, loadNetworkSpec } from './config.js';
import { LedgerStore, StaticShardRouter } from './store.js';
import { FileObjectStorage } from './objects.js';
import { CursorCodec } from './cursor.js';
import { ViemChainRpc } from './rpc.js';
import { BoundedChainQueue, CommunityIndexer, SingleFlightPoller } from './indexer.js';
import { createApi } from './api.js';
import type { Community } from './types.js';
import { communityKey } from './types.js';
import { failureReporter } from './runtime-health.js';

const report = failureReporter(message => console.error(message));
const pool = new Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:5000,statement_timeout:15_000,query_timeout:20_000});
const shardConfiguration = process.env.TERRA_SHARDS ? JSON.parse(process.env.TERRA_SHARDS) as Record<string,string> : {};
const pools = new Map([['local',pool],...Object.entries(shardConfiguration).map(([name,url]) => [name,new Pool({connectionString:url,max:8,connectionTimeoutMillis:5000,statement_timeout:15_000,query_timeout:20_000})] as const)]);
// Idle pooled sockets can disconnect when Docker/PostgreSQL restarts. pg drops
// the broken client; handling this event keeps the HTTP/index service alive.
for (const [name, shard] of pools) shard.on('error', error => report(`postgres ${name}`, error));
const assignments = process.env.TERRA_SHARD_ASSIGNMENTS ? JSON.parse(process.env.TERRA_SHARD_ASSIGNMENTS) as Record<string,string> : {};
const store = new LedgerStore(new StaticShardRouter(pools,assignments));
const objects = new FileObjectStorage(resolve(runtimePath,'objects'));
await store.migrate();
await mkdir(runtimePath,{recursive:true});
let cursorSecret = process.env.TERRA_CURSOR_SECRET;
if (!cursorSecret) {
  const path = resolve(runtimePath,'cursor-secret');
  try { cursorSecret = await readFile(path,'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    cursorSecret = randomBytes(32).toString('hex');
    await writeFile(path,cursorSecret,{flag:'wx',mode:0o600});
  }
}
const clients = new Map<string,{url:string;rpc:ViemChainRpc}>();
function rpc(community: Community): ViemChainRpc {
  const key = communityKey(community);
  const existing = clients.get(key);
  if (existing?.url === community.rpcUrl) return existing.rpc;
  if (clients.size>=1024) clients.delete(clients.keys().next().value!);
  const item = {url:community.rpcUrl,rpc:new ViemChainRpc(community.rpcUrl)};
  clients.set(key,item); return item.rpc;
}
let manifest: Community[] = [];
let loadedAt = 0;
async function communities(): Promise<Community[]> {
  if (Date.now()-loadedAt>1500) { manifest = await loadManifest(); loadedAt=Date.now(); }
  return manifest;
}
const queue = new BoundedChainQueue(Number(process.env.TERRA_INDEX_CONCURRENCY??2),Number(process.env.TERRA_INDEX_QUEUE_CAPACITY??128));
const indexer = new CommunityIndexer(store,objects,BigInt(process.env.TERRA_INDEX_BLOCK_RANGE??500),Number(process.env.TERRA_INDEX_MAX_LOGS??5000));
let rotation = 0;
async function schedule(): Promise<void> {
  try {
    const active = (await communities()).filter(item => item.status==='Active' && item.governor && item.registry);
    // Rotate admission order when the bounded queue is full so slow/crowded chains cannot starve later chains.
    for (let i=0;i<active.length;i++) {
      const community = active[(i+rotation)%active.length];
      queue.enqueue(communityKey(community),async()=> { const key = `index ${community.id}`; try { await indexer.tick(community,rpc(community)); report(key,null); } catch (error) { report(key,error); } });
    }
    rotation = active.length ? (rotation+1)%active.length : 0;
  } catch (error) { report('manifest',error); }
}
const poller = new SingleFlightPoller(schedule);
await poller.tick();
const interval = setInterval(()=>void poller.tick(),3000);
const port = Number(process.env.TERRA_LEDGER_PORT??5190);
const origins = new Set((process.env.TERRA_CORS_ORIGINS??'http://127.0.0.1:5185,http://localhost:5185,http://127.0.0.1:3000').split(','));
const api = createApi({store,objects,communities,protocol:loadProtocol,networkSpec:loadNetworkSpec,rpc,cursor:new CursorCodec(cursorSecret),objectBaseUrl:process.env.TERRA_OBJECT_BASE_URL??`http://127.0.0.1:${port}/v1`,allowedOrigins:origins});
api.listen(port,'127.0.0.1',()=>console.log(`Terra ledger service listening at http://127.0.0.1:${port}/v1`));
async function shutdown(): Promise<void> { clearInterval(interval); api.close(); await store.close(); process.exit(0); }
process.on('SIGINT',()=>void shutdown()); process.on('SIGTERM',()=>void shutdown());
