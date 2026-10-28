import { loadConfig } from './config.ts';
import type { Address } from './core/types.ts';
import { elysiumFromEnv } from './ingest/elysium.ts';
import { Store } from './store/db.ts';

/**
 * Indexes Ascend's Elysium testnet history into SQLite and exits.
 * `npm run sync`, then `npm run backtest:real` or `SOURCE=elysium npm run dev`.
 */
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const store = new Store(process.env.DB_PATH ?? 'data/radar.db');
const cfg = loadConfig({}, 'elysium');
const hubs = new Set<Address>();
const source = elysiumFromEnv(store, hubs, cfg);
const t0 = Date.now();
await source.syncToHead((cursor, head) => {
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`indexed to block ${cursor.toLocaleString()} / ${head.toLocaleString()} · ${store.eventCount().toLocaleString()} events · ${s}s`);
});
console.log(`done: ${store.eventCount().toLocaleString()} events, ${hubs.size} hubs discovered`);
store.close();
