import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BoundedChainQueue, CommunityIndexer, SingleFlightPoller } from '../src/indexer.js';
import type { LedgerStore } from '../src/store.js';
import type { ObjectStorage } from '../src/objects.js';

test('invalid worker settings cannot disable indexer resource bounds', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 17]) assert.throws(() => new BoundedChainQueue(value), /concurrency/);
  for (const value of [0, 1, 1.5, NaN, Infinity, 1025]) assert.throws(() => new BoundedChainQueue(2, value), /capacity/);
  const store = {} as LedgerStore;
  const objects = {} as ObjectStorage;
  for (const value of [0n, -1n, 5001n]) assert.throws(() => new CommunityIndexer(store, objects, value), /range/);
  for (const value of [0, 1.5, NaN, Infinity, 10001]) assert.throws(() => new CommunityIndexer(store, objects, 500n, value), /event bound/);
  for (const value of [0, 1.5, NaN, Infinity, 17]) assert.throws(() => new CommunityIndexer(store, objects, 500n, 5000, value), /batches/);
  assert.doesNotThrow(() => new BoundedChainQueue(16, 1024));
  assert.doesNotThrow(() => new CommunityIndexer(store, objects));
});

test('slow polling shares one task and releases backpressure after failure', async () => {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const poller = new SingleFlightPoller(async () => { calls++; await gate; if (calls === 1) throw new Error('temporary outage'); });
  const first = poller.tick();
  for (let i = 0; i < 1000; i++) assert.equal(poller.tick(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  const rejection = assert.rejects(first, /temporary outage/);
  release();
  await rejection;
  await poller.tick();
  assert.equal(calls, 2);
});

test('synchronous worker failures release capacity for other chains', async () => {
  const queue = new BoundedChainQueue(1, 2);
  let finished = false;
  queue.enqueue('failed', () => { throw new Error('bad adapter'); });
  queue.enqueue('independent', async () => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, true);
  assert.equal(queue.size, 0);
});
