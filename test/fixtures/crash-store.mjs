import { Store } from '../../src/core/store.mjs';
const store = new Store(process.argv[2]);
store.transaction(() => { store.setMeta('committed', 'durable'); store.receipt('committed-receipt', 1); });
store.db.exec('BEGIN IMMEDIATE');
store.setMeta('committed', 'uncommitted');
store.receipt('uncommitted-receipt', 2);
process.exit(9);
