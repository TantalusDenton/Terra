import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabaseUrl } from '../src/database-config.js';

test('local database uses the same caller-provided password as Compose, with URL escaping', () => {
  const fixture = 'local' + ':@/?#% unicode';
  const url = new URL(getDatabaseUrl({ TERRA_POSTGRES_PASSWORD: fixture }));
  assert.equal(decodeURIComponent(url.password), fixture);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55432');
});

test('explicit database URL takes precedence over the local Compose configuration', () => {
  const url = 'postgresql://localhost:5432/terra-test?sslmode=require';
  assert.equal(getDatabaseUrl({ DATABASE_URL: url, TERRA_POSTGRES_PASSWORD: 'unused' }), url);
});

test('database commands require explicit credentials while unit modules remain importable', () => {
  assert.throws(() => getDatabaseUrl({}), /Set DATABASE_URL or TERRA_POSTGRES_PASSWORD/);
  assert.throws(() => getDatabaseUrl({ TERRA_POSTGRES_PASSWORD: '' }), /Set DATABASE_URL/);
});

test('invalid database configuration fails without echoing the supplied value', () => {
  for (const url of ['', 'https://localhost/terra', 'postgresql://']) {
    assert.throws(() => getDatabaseUrl({ DATABASE_URL: url }), { message: 'DATABASE_URL must be a PostgreSQL connection URL.' });
  }
});
