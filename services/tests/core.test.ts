import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { keccak256 } from 'viem';
import { CursorCodec, pageLimit } from '../src/cursor.js';
import { decimal, communityKey } from '../src/types.js';
import { normalizeCommunity } from '../src/config.js';
import { FileObjectStorage, validateLogo } from '../src/objects.js';
import { BoundedChainQueue } from '../src/indexer.js';
import { proposalState } from '../src/store.js';
import { logoMessage } from '../src/api.js';

test('uint256 data keeps decimal precision beyond a billion and JS safe integer',()=> {
  assert.equal(decimal('10000000001'),'10000000001');
  assert.equal(decimal('9007199254740993000'),'9007199254740993000');
  assert.equal(decimal((1n<<256n)-1n),((1n<<256n)-1n).toString());
  assert.throws(()=>decimal(Number.MAX_SAFE_INTEGER+1),/Unsafe/);
  assert.throws(()=>decimal(1n<<256n),/exceeds/);
  assert.throws(()=>decimal('-1'),/Invalid/);
});
test('query cursors are signed, community isolated, and precision preserving',()=> {
  const codec = new CursorCodec('012345678901234567890123456789012345');
  const input = {v:1 as const,community:'84532:0x123',before:'9007199254740993000',ceiling:'999999999999999999999',state:'Active'};
  const token = codec.encode(input);
  assert.deepEqual(codec.decode(token,input.community,'Active'),input);
  assert.throws(()=>codec.decode(token,'84533:0x123','Active'),/different query/);
  assert.throws(()=>codec.decode(token,input.community,'Passed'),/different query/);
  assert.throws(()=>codec.decode(`${token.slice(0,-1)}x`,input.community,'Active'),/signature/);
  assert.equal(pageLimit(null),20); assert.equal(pageLimit('100'),100);
  for (const invalid of ['0','101','200000','-1','1.5','NaN']) assert.throws(()=>pageLimit(invalid));
});
test('same governor addresses on different chains have independent cache identities',()=> {
  const raw = {status:'Active',rpcUrl:'http://127.0.0.1:8545',governor:'0x0000000000000000000000000000000000000001',registry:'0x0000000000000000000000000000000000000002'};
  assert.notEqual(communityKey(normalizeCommunity({...raw,chainId:'123'})),communityKey(normalizeCommunity({...raw,chainId:'124'})));
  assert.throws(()=>normalizeCommunity({...raw,chainId:Number.MAX_SAFE_INTEGER+1}),/Unsafe/);
});
test('content addressed originals verify byte integrity and detect corruption',async()=> {
  const directory = await mkdtemp(resolve(tmpdir(),'terra-object-test-'));
  try {
    const objects = new FileObjectStorage(directory);
    const bytes = Buffer.from('unmodified policy bytes');
    const hash = await objects.put(bytes,'text/plain');
    assert.equal(hash,keccak256(bytes));
    assert.deepEqual((await objects.get(hash)).bytes,bytes);
    assert.equal(await objects.put(bytes,'text/plain'),hash);
    await writeFile(resolve(directory,hash.slice(2,4),hash.slice(2)),'corrupt');
    await assert.rejects(objects.get(hash),/integrity/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('logos validate encoded format and decoded dimensions without changing original bytes',async()=> {
  const png = await sharp({create:{width:16,height:16,channels:3,background:'#064B8E'}}).png().toBuffer();
  assert.deepEqual(await validateLogo(png),{mime:'image/png',width:16,height:16});
  const jpeg = await sharp(png).jpeg().toBuffer();
  assert.equal((await validateLogo(jpeg)).mime,'image/jpeg');
  const webp = await sharp(png).webp().toBuffer();
  assert.equal((await validateLogo(webp)).mime,'image/webp');
  await assert.rejects(validateLogo(Buffer.from('<svg/>')));
  await assert.rejects(validateLogo(Buffer.alloc(2*1024*1024+1)),/2 MiB/);
  const tooWide = await sharp({create:{width:4097,height:1,channels:3,background:'#fff'}}).png().toBuffer();
  await assert.rejects(validateLogo(tooWide),/dimensions/);
  await assert.rejects(validateLogo(png.subarray(0,32)));
});
test('chain queues deduplicate, limit total admission, and never exceed concurrency',async()=> {
  const queue = new BoundedChainQueue(2,3);
  let active = 0; let maximum = 0; let complete = 0;
  let release!:()=>void;
  const gate = new Promise<void>(resolve=>{release=resolve;});
  const work = async()=> { active++; maximum=Math.max(maximum,active); await gate; active--; complete++; };
  assert.equal(queue.enqueue('a',work),true);
  assert.equal(queue.enqueue('a',work),false);
  assert.equal(queue.enqueue('b',work),true);
  assert.equal(queue.enqueue('c',work),true);
  assert.equal(queue.enqueue('d',work),false);
  assert.equal(queue.size,3); release();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(maximum,2); assert.equal(complete,3); assert.equal(queue.size,0);
});
test('proposal state uses source block timestamp and uint256 tally comparisons',()=> {
  const base={executed:false,ends_at:'100',yes:'9007199254740993001',no:'9007199254740993000'};
  assert.equal(proposalState(base,'99'),'Active');
  assert.equal(proposalState(base,'100'),'Passed');
  assert.equal(proposalState({...base,yes:base.no},'100'),'Defeated');
  assert.equal(proposalState({...base,yes:'0',no:'0'},'100'),'Defeated');
  assert.equal(proposalState({...base,executed:true},'100'),'Executed');
});
test('logo signatures bind wallet, registry, chain, content, and timestamp',()=> {
  const community=normalizeCommunity({chainId:'84532',governor:'0x0000000000000000000000000000000000000001',registry:'0x0000000000000000000000000000000000000002',rpcUrl:'http://localhost:8545'});
  const message=logoMessage(community,'0x0000000000000000000000000000000000000003',keccak256(Buffer.from('logo')),'1234');
  assert.match(message,/Chain: 84532/); assert.match(message,/IssuedAt: 1234$/);
  assert.match(message,/Registry: 0x0000000000000000000000000000000000000002/);
});
