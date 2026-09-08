/**
 * OpenCode seq polling, backoff, drift degradation (tasks.md 17.1-17.6; design.md "OpenCode
 * SQLite" table; spec: "SQLITE_BUSY triggers backoff, not failure", "No WAL side-file deletion").
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSyntheticOpenCodeDb, seedEvent, seedSession } from '../../../../test/helpers/opencode-db';
import { openOpenCodeDbReadOnly } from './db';
import {
  BACKOFF_CAP_MS,
  backoffDelayWithFullJitter,
  isSqliteBusyError,
  nextSeqCheckpoint,
  pollWithBackoff,
  selectEventsSince,
} from './poll';

describe('selectEventsSince (tasks.md 17.1, 17.2)', () => {
  let scratchDir: string;

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  it('returns events for one session in ascending seq order, none skipped', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-poll-'));
    const dbPath = join(scratchDir, 'opencode.db');
    const writer = buildSyntheticOpenCodeDb(dbPath);
    seedSession(writer, { id: 'ses_1' });
    seedEvent(writer, { id: 'evt_3', aggregate_id: 'ses_1', seq: 3, type: 'session.updated.1', data: '{}' });
    seedEvent(writer, { id: 'evt_1', aggregate_id: 'ses_1', seq: 1, type: 'session.created.1', data: '{}' });
    seedEvent(writer, { id: 'evt_2', aggregate_id: 'ses_1', seq: 2, type: 'message.updated.1', data: '{}' });
    writer.close();

    const opened = openOpenCodeDbReadOnly(dbPath);
    if (opened.status !== 'ready') throw new Error('expected ready');

    const rows = selectEventsSince(opened.handle.db, 'ses_1', 0);

    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    opened.handle.close();
  });

  it('only returns events after sinceSeq, and only for the requested aggregate', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-poll-'));
    const dbPath = join(scratchDir, 'opencode.db');
    const writer = buildSyntheticOpenCodeDb(dbPath);
    seedSession(writer, { id: 'ses_1' });
    seedSession(writer, { id: 'ses_2' });
    seedEvent(writer, { id: 'evt_1', aggregate_id: 'ses_1', seq: 1, type: 'session.created.1', data: '{}' });
    seedEvent(writer, { id: 'evt_2', aggregate_id: 'ses_1', seq: 2, type: 'session.updated.1', data: '{}' });
    seedEvent(writer, { id: 'evt_3', aggregate_id: 'ses_2', seq: 1, type: 'session.created.1', data: '{}' });
    writer.close();

    const opened = openOpenCodeDbReadOnly(dbPath);
    if (opened.status !== 'ready') throw new Error('expected ready');

    const rows = selectEventsSince(opened.handle.db, 'ses_1', 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 2, type: 'session.updated.1' });
    opened.handle.close();
  });
});

describe('backoff schedule (tasks.md 17.3)', () => {
  it('follows the documented 50->100->200->400->800->1600 schedule, capped at 2000ms', () => {
    const noJitter = () => 1; // random() = 1 => delay == the full base (upper bound of "full jitter")
    const delays = [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelayWithFullJitter(attempt, noJitter));
    expect(delays).toEqual([50, 100, 200, 400, 800, 1600, 2000, 2000]);
  });

  it('full jitter: delay is always between 0 and the base for that attempt', () => {
    const fixedRandom = () => 0.5;
    expect(backoffDelayWithFullJitter(0, fixedRandom)).toBe(25);
    expect(backoffDelayWithFullJitter(5, fixedRandom)).toBe(800);
    expect(backoffDelayWithFullJitter(20, fixedRandom)).toBe(BACKOFF_CAP_MS / 2);
  });
});

describe('isSqliteBusyError (tasks.md 17.4)', () => {
  it('recognizes SQLITE_BUSY, SQLITE_BUSY_SNAPSHOT and SQLITE_LOCKED by errcode', () => {
    expect(isSqliteBusyError(Object.assign(new Error('busy'), { errcode: 5 }))).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error('locked'), { errcode: 6 }))).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error('busy snapshot'), { errcode: 517 }))).toBe(true);
  });

  it('near-miss twin: an unrelated sqlite error (e.g. readonly, errcode 8) is NOT classified as busy', () => {
    expect(isSqliteBusyError(Object.assign(new Error('attempt to write a readonly database'), { errcode: 8 }))).toBe(
      false,
    );
  });
});

describe('pollWithBackoff (tasks.md 17.3, 17.4: SQLITE_BUSY triggers backoff, never surfaces as a failure)', () => {
  it('retries through SQLITE_BUSY and eventually returns the query result, never throwing', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const query = () => {
      attempts++;
      if (attempts < 4) throw Object.assign(new Error('database is locked'), { errcode: 5 });
      return [{ seq: 1, type: 'x', data: null }];
    };

    const result = await pollWithBackoff({
      query,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0, // zero jitter, deterministic
    });

    expect(result).toEqual([{ seq: 1, type: 'x', data: null }]);
    expect(attempts).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  it('a non-busy error is never retried and propagates immediately', async () => {
    const query = () => {
      throw new Error('boom, not a busy error');
    };

    await expect(pollWithBackoff({ query, sleep: async () => {} })).rejects.toThrow('boom, not a busy error');
  });

  it('emits onDegraded exactly once after 30s of continuous busy, and keeps retrying afterward', async () => {
    let attempts = 0;
    let clock = 0;
    let degradedCalls = 0;
    const query = () => {
      attempts++;
      clock += 10_000; // simulate 10s passing per busy attempt
      if (attempts < 5) throw Object.assign(new Error('busy'), { errcode: 5 });
      return [];
    };

    await pollWithBackoff({
      query,
      sleep: async () => {},
      random: () => 0,
      now: () => clock,
      onDegraded: () => {
        degradedCalls++;
      },
    });

    expect(degradedCalls).toBe(1);
  });
});

describe('nextSeqCheckpoint (tasks.md 17.5: checkpoint max(seq), committed only after batch publish)', () => {
  it('advances bySession[aggregateId] to the max seq of the published batch', () => {
    const current = { kind: 'seq' as const, bySession: { ses_1: 5 } };

    const next = nextSeqCheckpoint(current, 'ses_1', [
      { seq: 6, type: 'a', data: null },
      { seq: 8, type: 'b', data: null },
      { seq: 7, type: 'c', data: null },
    ]);

    expect(next.bySession.ses_1).toBe(8);
    expect(current.bySession.ses_1).toBe(5); // pure — the input checkpoint is never mutated
  });

  it('is a no-op (returns the same reference) when the batch is empty — never commits ahead of publish', () => {
    const current = { kind: 'seq' as const, bySession: { ses_1: 5 } };

    const next = nextSeqCheckpoint(current, 'ses_1', []);

    expect(next).toBe(current);
  });
});

describe('Threat Matrix case h: db and -wal byte-identical, -shm never deleted, after a full poll cycle (tasks.md 17.6)', () => {
  let scratchDir: string;

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  /**
   * `-shm` is SQLite's shared reader/writer coordination index, not committed data — a manual
   * smoke test against the REAL `~/.local/share/opencode/opencode.db` (tasks.md 19.2) found that
   * `-shm`'s CONTENT and mtime legitimately change on a genuinely read-only WAL-mode read (this
   * is documented SQLite behavior, not something this adapter chooses to do). An earlier version
   * of this test asserted `-shm` byte-identity too and passed — but only because its 1-row
   * synthetic fixture was too small to exercise that bookkeeping path, which would have made the
   * test pass for the wrong reason against a realistically-sized db. This version seeds enough
   * rows to reproduce the real mutation path, and asserts the invariant design.md actually states
   * (never write to the db, never touch `-wal`, never DELETE `-shm`) rather than a stronger one
   * that real SQLite cannot honor for any reader.
   */
  it('running open + probe + a full poll cycle leaves db and -wal byte-identical; -shm keeps its size and is never deleted', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-poll-cycle-'));
    const dbPath = join(scratchDir, 'opencode.db');
    const writer = buildSyntheticOpenCodeDb(dbPath);
    writer.exec('PRAGMA journal_mode=WAL');
    seedSession(writer, { id: 'ses_1', agent: 'observador' });
    for (let seq = 1; seq <= 500; seq++) {
      seedEvent(writer, { id: `evt_${seq}`, aggregate_id: 'ses_1', seq, type: 'message.part.updated.1', data: '{}' });
    }
    // `writer` stays open, simulating a live OpenCode process holding the WAL.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);

    const snapshot = () => ({
      db: { size: statSync(dbPath).size, sha256: createHash('sha256').update(readFileSync(dbPath)).digest('hex') },
      wal: {
        size: statSync(`${dbPath}-wal`).size,
        sha256: createHash('sha256').update(readFileSync(`${dbPath}-wal`)).digest('hex'),
      },
      shmExists: existsSync(`${dbPath}-shm`),
      shmSize: statSync(`${dbPath}-shm`).size,
    });
    const before = snapshot();

    const opened = openOpenCodeDbReadOnly(dbPath);
    if (opened.status !== 'ready') throw new Error('expected ready');
    const rows = await pollWithBackoff({
      query: () => selectEventsSince(opened.handle.db, 'ses_1', 0),
      sleep: async () => {},
    });
    expect(rows).toHaveLength(500);
    opened.handle.close();

    const after = snapshot();

    expect(after.db).toEqual(before.db);
    expect(after.wal).toEqual(before.wal);
    expect(after.shmExists).toBe(true);
    expect(after.shmSize).toBe(before.shmSize);
    writer.close();
  });
});
