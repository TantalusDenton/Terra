import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { failureReporter } from '../src/runtime-health.js';

test('idle PostgreSQL disconnects can be handled without exposing the client object', async () => {
  const messages: string[] = []; const report = failureReporter(message => messages.push(message));
  const pool = new Pool(); pool.on('error', error => report('postgres local',error));
  pool.emit('error',new Error('connection terminated unexpectedly'),{ secretKey: 'never log client state' });
  assert.deepEqual(messages,['[postgres local] connection terminated unexpectedly']);
  await pool.end();
});

test('unchanged outages are rate limited and recovery permits the next failure report', () => {
  let time = 0; const messages: string[] = []; const report = failureReporter(message => messages.push(message),()=>time);
  report('chain',new Error('offline')); time = 1000; report('chain',new Error('offline'));
  assert.equal(messages.length,1); time = 60000; report('chain',new Error('offline'));
  assert.equal(messages.length,2); report('chain',null); report('chain',new Error('offline'));
  assert.equal(messages.length,3);
});
