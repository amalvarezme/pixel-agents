/**
 * OpenCode read-only db open (tasks.md 16.1, 16.2, 16.5; design.md "Decision: read-only SQLite
 * for OpenCode, never `immutable=1`"; spec: "OpenCode Read-Only Access Invariants").
 *
 * `design.md` line 459 deferred the driver pick to slice 3; resolved to `node:sqlite`
 * (`DatabaseSync`) — see `test/spikes/opencode-schema-probe.spike.mjs` for the verified spike.
 * `better-sqlite3` is NOT installed and never will be for this adapter.
 *
 * Every test here operates on a brand-new scratch db built by `test/helpers/opencode-db.ts` —
 * NEVER the real `~/.local/share/opencode/opencode.db`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSyntheticOpenCodeDb, seedSession } from '../../../../test/helpers/opencode-db';
import { openOpenCodeDbReadOnly } from './db';

describe('openOpenCodeDbReadOnly (tasks.md 16.1)', () => {
  let scratchDir: string;

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  it('opens a synthetic db read-only and returns a ready handle', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-db-'));
    const dbPath = join(scratchDir, 'opencode.db');
    const writer = buildSyntheticOpenCodeDb(dbPath);
    seedSession(writer, { id: 'ses_1', title: 'root session' });
    writer.close();

    const result = openOpenCodeDbReadOnly(dbPath);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    const rows = result.handle.db.prepare('SELECT id, title FROM session').all();
    expect(rows).toEqual([{ id: 'ses_1', title: 'root session' }]);
    result.handle.close();
  });

  it('rejects any write statement on the adapter connection (Threat Matrix case f)', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-db-'));
    const dbPath = join(scratchDir, 'opencode.db');
    const writer = buildSyntheticOpenCodeDb(dbPath);
    seedSession(writer, { id: 'ses_1', title: 'root session' });
    writer.close();

    const result = openOpenCodeDbReadOnly(dbPath);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');

    expect(() => result.handle.db.exec("INSERT INTO session (id, title, time_created, time_updated) VALUES ('x','x',0,0)")).toThrow();
    expect(() => result.handle.db.exec('CREATE TABLE evil (x)')).toThrow();
    result.handle.close();
  });

  it('degrades to disabled(wal_shm_unavailable) when -shm is missing while -wal is present, never falls back to immutable=1 (Threat Matrix case g)', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-db-'));
    const dbPath = join(scratchDir, 'opencode.db');
    const writer = buildSyntheticOpenCodeDb(dbPath);
    writer.exec('PRAGMA journal_mode=WAL');
    seedSession(writer, { id: 'ses_1', title: 'root session' });
    // Keep `writer` open — a running OpenCode process holds the WAL open exactly like this.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    rmSync(`${dbPath}-shm`);

    const result = openOpenCodeDbReadOnly(dbPath);

    expect(result).toEqual({
      status: 'disabled',
      reason: 'wal_shm_unavailable',
      detail: expect.any(String),
    });
    writer.close();
  });

  it('near-miss twin: when both -wal and -shm are present, the same db opens ready (proves the guard checks shm-absence specifically)', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-db-'));
    const dbPath = join(scratchDir, 'opencode.db');
    const writer = buildSyntheticOpenCodeDb(dbPath);
    writer.exec('PRAGMA journal_mode=WAL');
    seedSession(writer, { id: 'ses_1', title: 'root session' });
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);

    const result = openOpenCodeDbReadOnly(dbPath);

    expect(result.status).toBe('ready');
    if (result.status === 'ready') result.handle.close();
    writer.close();
  });

  it('a missing db file degrades to disabled rather than throwing', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-db-'));
    const dbPath = join(scratchDir, 'does-not-exist.db');

    const result = openOpenCodeDbReadOnly(dbPath);

    expect(result.status).toBe('disabled');
  });
});
