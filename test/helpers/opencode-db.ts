/**
 * Synthetic `opencode.db` builder for tests (tasks.md 16.4, 16.5, 17.6, 18.1: "using the
 * synthetic-db fixture built from the captured DDL, never the live db"). The DDL below is the
 * subset of `research-local-evidence.md` Q3's captured schema that the adapter actually depends
 * on — not all 19 real tables, only `session`, `message`, `part`, `event`, `event_sequence`, plus
 * the two indexes the adapter's queries rely on.
 *
 * NEVER used against a real `~/.local/share/opencode/opencode.db` — this module only ever
 * creates brand-new scratch files.
 */
import { createRequire } from 'node:module';

// See src/adapters/driven/opencode/db.ts for why `node:sqlite` is loaded via `createRequire`
// rather than a static import (the pinned Vite/vite-node version predates this Node builtin).
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

export interface SeedSessionRow {
  id: string;
  parent_id?: string | null;
  title?: string;
  agent?: string | null;
  time_created?: number;
  time_updated?: number;
}

export interface SeedMessageRow {
  id: string;
  session_id: string;
  data: string;
  time_created?: number;
  time_updated?: number;
}

export interface SeedPartRow {
  id: string;
  message_id: string;
  session_id: string;
  data: string;
  time_created?: number;
  time_updated?: number;
}

export interface SeedEventRow {
  id: string;
  aggregate_id: string;
  seq: number;
  type: string;
  data: string;
}

/** Creates the captured-DDL subset of tables in a brand-new scratch db file. Returns the open connection. */
export function buildSyntheticOpenCodeDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      title TEXT NOT NULL,
      agent TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE INDEX session_parent_idx ON session (parent_id);

    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY);

    CREATE TABLE event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq);
  `);
  return db;
}

export function seedSession(db: DatabaseSync, row: SeedSessionRow): void {
  db.prepare(
    `INSERT INTO session (id, parent_id, title, agent, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.parent_id ?? null,
    row.title ?? row.id,
    row.agent ?? null,
    row.time_created ?? Date.now(),
    row.time_updated ?? Date.now(),
  );
}

export function seedMessage(db: DatabaseSync, row: SeedMessageRow): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run(row.id, row.session_id, row.time_created ?? now, row.time_updated ?? now, row.data);
}

export function seedPart(db: DatabaseSync, row: SeedPartRow): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.message_id, row.session_id, row.time_created ?? now, row.time_updated ?? now, row.data);
}

export function seedEvent(db: DatabaseSync, row: SeedEventRow): void {
  db.prepare(`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)`).run(
    row.id,
    row.aggregate_id,
    row.seq,
    row.type,
    row.data,
  );
}

/**
 * Simulates schema drift: drops one column from one table (sqlite 3.35+ supports DROP COLUMN).
 * Drops any index on that table first — sqlite refuses to drop a column an index still
 * references, and the synthetic db's `event_aggregate_seq_idx` covers exactly the drift columns
 * these tests exercise.
 */
export function dropColumn(db: DatabaseSync, table: string, column: string): void {
  const indexes = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ?').all('index', table) as Array<{
    name: string;
  }>;
  for (const index of indexes) {
    if (index.name.startsWith('sqlite_autoindex_')) continue;
    db.exec(`DROP INDEX ${index.name}`);
  }
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
