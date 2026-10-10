import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAddress, keccak256, type Address, type Hex } from 'viem';
import type { Community, PolicyContent } from './types.js';
import { communityKey, decimal, json } from './types.js';
import { CursorCodec, pageLimit } from './cursor.js';
import { type LedgerStore, type ProposalFilter } from './store.js';
import { type ObjectStorage, validateLogo } from './objects.js';
import type { ChainRpc } from './rpc.js';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export interface ApiDependencies {
  store: LedgerStore;
  objects: ObjectStorage;
  communities(): Promise<Community[]>;
  protocol?(): Promise<Record<string, unknown>>;
  networkSpec?(): Promise<Record<string, unknown>>;
  rpc(community: Community): ChainRpc;
  cursor: CursorCodec;
  objectBaseUrl: string;
  allowedOrigins: Set<string>;
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  response.end(json(body));
}
async function bytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const length = request.headers['content-length'];
  if (length && Number(length) > limit) throw new HttpError(413,'Logo must be at most 2 MiB');
  const parts: Buffer[] = []; let received = 0;
  for await (const part of request) {
    received += (part as Buffer).length;
    if (received > limit) throw new HttpError(413,'Logo must be at most 2 MiB');
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}
function header(request: IncomingMessage, key: string): string {
  const value = request.headers[key];
  return typeof value === 'string' ? value : '';
}
export function logoMessage(community: Community, wallet: Address, hash: Hex, issuedAt: string): string {
  return `Terra logo upload\nChain: ${community.chainId}\nRegistry: ${community.registry!.toLowerCase()}\nWallet: ${wallet.toLowerCase()}\nHash: ${hash}\nIssuedAt: ${issuedAt}`;
}

export function createApi(dependencies: ApiDependencies) {
  const balanceCache = new Map<string,{expires:number;balance:string}>();
  const allowedStates = new Set(['','Active','Defeated','Passed','Executed','Results']);
  return createServer(async (request,response) => {
    try {
      const origin = header(request,'origin');
      if (origin && !dependencies.allowedOrigins.has(origin)) throw new HttpError(403,'Origin is not permitted');
      if (origin) { response.setHeader('access-control-allow-origin',origin); response.setHeader('vary','Origin'); }
      if (request.method === 'OPTIONS') {
        response.writeHead(204,{'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'Content-Type,X-Terra-Wallet,X-Terra-Signature,X-Terra-Message'}); response.end(); return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/$/,'');
      if (path === '/health' && request.method === 'GET') { await dependencies.store.health(); send(response,200,{status:'ok'}); return; }
      if (path === '/v1/protocol' && request.method === 'GET') {
        if (!dependencies.protocol) throw new HttpError(503,'Multichain protocol manifest is unavailable');
        send(response,200,await dependencies.protocol()); return;
      }
      if (path === '/v1/network-spec' && request.method === 'GET') {
        if (!dependencies.networkSpec) throw new HttpError(503,'Supported network template is unavailable');
        try { send(response,200,await dependencies.networkSpec()); }
        catch { throw new HttpError(503,'Supported operator network template is unavailable'); }
        return;
      }
      if (path.startsWith('/v1/objects/') && request.method === 'GET') {
        const hash = path.slice('/v1/objects/'.length) as Hex;
        if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new HttpError(400,'Invalid content hash');
        const object = await dependencies.objects.get(hash);
        response.writeHead(200,{'content-type':object.mime,'content-length':String(object.bytes.length),'cache-control':'public, max-age=31536000, immutable','etag':`"${hash}"`,'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});
        response.end(object.bytes); return;
      }
      const communities = await dependencies.communities();
      if (path === '/v1/logos' && request.method === 'POST') {
        const terra = communities.find(item => item.kind === 'terra' && item.status === 'Active');
        if (!terra?.registry) throw new HttpError(503,'Terra citizenship is unavailable for upload authorization');
        const buffer = await bytes(request,2*1024*1024);
        const hash = keccak256(buffer);
        const wallet = header(request,'x-terra-wallet');
        const signature = header(request,'x-terra-signature');
        const message = header(request,'x-terra-message');
        // HTTP headers cannot contain newlines; browser sends the exact message base64url-encoded.
        let decoded: string;
        try { decoded = Buffer.from(message,'base64url').toString('utf8'); } catch { throw new HttpError(401,'Invalid upload authorization'); }
        const issued = /\nIssuedAt: (\d{1,12})$/.exec(decoded)?.[1];
        if (!isAddress(wallet) || !/^0x[0-9a-fA-F]+$/.test(signature) || !issued) throw new HttpError(401,'Signed Terra citizenship authorization is required');
        const now = Math.floor(Date.now()/1000);
        if (now-Number(issued)>300 || Number(issued)-now>30 || decoded !== logoMessage(terra,wallet,hash,issued)) throw new HttpError(401,'Upload authorization is expired or belongs to different content');
        const rpc = dependencies.rpc(terra);
        if (BigInt(await rpc.identity())!==BigInt(terra.chainId)) throw new HttpError(503,'Terra RPC identity does not match its deployment');
        if (!await rpc.verifyMessage(wallet,decoded,signature as Hex)) throw new HttpError(401,'Invalid wallet signature');
        if (!await rpc.isCitizen(terra.registry,wallet)) throw new HttpError(403,'Only Terra citizens may upload corporation logos');
        let metadata: Awaited<ReturnType<typeof validateLogo>>;
        try { metadata=await validateLogo(buffer); }
        catch (error) { throw new HttpError(400,error instanceof Error?error.message:'Invalid logo image'); }
        await dependencies.objects.put(buffer,metadata.mime);
        send(response,201,{hash,uri:`${dependencies.objectBaseUrl}/objects/${hash}`,size:buffer.length,...metadata}); return;
      }
      if (path === '/v1/communities' && request.method === 'GET') {
        const limit = pageLimit(url.searchParams.get('limit'));
        const token = url.searchParams.get('cursor');
        const cursor = token ? dependencies.cursor.decode(token,'directory') : undefined;
        const corporations = communities.filter(item => item.kind === 'blockshares');
        if (corporations.some(item => !/^\d+$/.test(item.id))) throw new Error('Corporation ids must be directory request decimal strings');
        const ceiling = cursor?.ceiling ?? corporations.reduce((max,item) => BigInt(item.id)>BigInt(max)?item.id:max,'0');
        const rows = corporations.filter(item => BigInt(item.id)<=BigInt(ceiling) && (!cursor || BigInt(item.id)<BigInt(cursor.before))).sort((a,b)=> BigInt(a.id)>BigInt(b.id)?-1:1);
        const terra = cursor ? [] : communities.filter(item => item.kind === 'terra');
        const selected = [...terra,...rows].slice(0,limit+1);
        const more = selected.length>limit;
        const items = selected.slice(0,limit);
        const last = items.at(-1);
        const before = last?.kind === 'blockshares' ? last.id : (BigInt(ceiling)+1n).toString();
        send(response,200,{items,nextCursor:more?dependencies.cursor.encode({v:1,community:'directory',before,ceiling,state:''}):null}); return;
      }
      const deploymentMatch = /^\/v1\/communities\/([a-zA-Z0-9_-]{1,100})\/deployment$/.exec(path);
      if (deploymentMatch && request.method === 'GET') {
        const community = communities.find(item => item.id === deploymentMatch[1]);
        if (!community) throw new HttpError(404,'Community not found');
        send(response,200,{community,trustAssumption:'Operator attestation is not a cryptographic proof of remote-chain correctness.'}); return;
      }
      const match = /^\/v1\/communities\/([a-zA-Z0-9_-]{1,100})(?:\/proposals(?:\/(\d{1,78}))?)?$/.exec(path);
      if (!match || request.method !== 'GET') throw new HttpError(404,'Endpoint not found');
      const community = communities.find(item => item.id===match[1]);
      if (!community) throw new HttpError(404,'Community not found');
      if (community.status !== 'Active' || !community.governor) {
        if (path.includes('/proposals')) throw new HttpError(409,'Community has not been activated');
        send(response,200,{community,source:null,counts:null,treasuryBalanceWei:null}); return;
      }
      const key = communityKey(community);
      const summary = await dependencies.store.summary(key);
      if (!summary) throw new HttpError(503,'Blockchain records are still being indexed');
      if (path.includes('/proposals')) {
        if (match[2]) {
          const detail = await dependencies.store.proposal(key,decimal(match[2]),summary.source.timestamp);
          if (!detail) throw new HttpError(404,'Proposal not found at the indexed source block');
          const object = await dependencies.objects.get(detail.contentHash as Hex);
          const content = JSON.parse(object.bytes.toString()) as PolicyContent;
          send(response,200,{proposal:{...detail.card,...content},source:summary.source,indexerError:summary.error??null}); return;
        }
        const limit = pageLimit(url.searchParams.get('limit'));
        const state = url.searchParams.get('state')??'';
        if (!allowedStates.has(state)) throw new HttpError(400,'Invalid proposal state');
        const token = url.searchParams.get('cursor');
        const cursor = token ? dependencies.cursor.decode(token,key,state) : undefined;
        const result = await dependencies.store.proposalPage(key,limit+1,cursor?.before,cursor?.ceiling,summary.source.timestamp,state as ProposalFilter);
        const more = result.items.length>limit;
        const items = result.items.slice(0,limit);
        send(response,200,{items,nextCursor:more?dependencies.cursor.encode({v:1,community:key,before:items.at(-1)!.id,ceiling:result.ceiling,state}):null,source:summary.source,indexerError:summary.error??null}); return;
      }
      const balanceKey = `${key}:${summary.source.blockHash}`;
      let cached = balanceCache.get(balanceKey);
      if (!cached || cached.expires<Date.now()) {
        const rpc = dependencies.rpc(community);
        const block = await rpc.block(BigInt(summary.source.blockNumber));
        if (block.hash !== summary.source.blockHash) throw new HttpError(503,'Canonical source changed; index recovery is in progress');
        const balance = await rpc.balance(community.governor,BigInt(summary.source.blockNumber));
        if ((await rpc.block(BigInt(summary.source.blockNumber))).hash !== block.hash) throw new HttpError(503,'Canonical source changed during balance read');
        if (balanceCache.size>=1000) balanceCache.delete(balanceCache.keys().next().value!);
        cached = {expires:Date.now()+2000,balance:balance.toString()}; balanceCache.set(balanceKey,cached);
      }
      send(response,200,{community,source:summary.source,counts:summary.counts,treasuryBalanceWei:cached.balance,indexerError:summary.error??null});
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 :
        error instanceof Error && /^(Invalid|limit|Cursor|Unsafe|Logo|Logo dimensions|Logo must)/.test(error.message) ? 400 : 503;
      send(response,status,{error:error instanceof Error?error.message:'Ledger service unavailable'});
    }
  });
}
