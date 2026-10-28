import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChainEvent } from '../core/types.ts';

/**
 * SQLite persistence (node:sqlite, no dependencies). The chain events a source
 * produced are stored in order, so a restart replays them into a fresh engine
 * and resumes from the saved cursor. A key/value table holds cursors, watched
 * wallets and Pro keys; a cache table holds slow lookups (funding history,
 * token metadata, tx senders) so re-syncs and backtests are reproducible.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, block INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }

  appendEvents(events: ChainEvent[]): void {
    if (!events.length) return;
    const stmt = this.db.prepare('INSERT INTO events (block, json) VALUES (?, ?)');
    this.tx(() => {
      for (const e of events) stmt.run(e.block, JSON.stringify(e));
    });
  }

  *events(): Generator<ChainEvent> {
    const stmt = this.db.prepare('SELECT json FROM events ORDER BY id');
    for (const row of stmt.iterate() as Iterable<{ json: string }>) yield JSON.parse(row.json) as ChainEvent;
  }

  eventCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  }

  get<T>(k: string): T | undefined {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as T) : undefined;
  }

  set(k: string, v: unknown): void {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
  }

  cached<T>(k: string): T | undefined {
    const row = this.db.prepare('SELECT v FROM cache WHERE k = ?').get(k) as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as T) : undefined;
  }

  cache(k: string, v: unknown): void {
    this.db
      .prepare('INSERT INTO cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
      .run(k, JSON.stringify(v), Date.now());
  }

  /** Atomically commit a batch of events together with the cursor that produced them. */
  commit(events: ChainEvent[], cursorKey: string, cursor: unknown): void {
    this.tx(() => {
      this.appendEvents(events);
      this.set(cursorKey, cursor);
    });
  }

  tx(fn: () => void): void {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
