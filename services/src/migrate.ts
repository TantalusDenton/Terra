import { Pool } from 'pg';
import { getDatabaseUrl } from './config.js';
import { LedgerStore, StaticShardRouter } from './store.js';
const store = new LedgerStore(new StaticShardRouter(new Map([['local',new Pool({connectionString:getDatabaseUrl()})]])));
try { await store.migrate(); console.log('Terra ledger schema ready'); }
finally { await store.close(); }
