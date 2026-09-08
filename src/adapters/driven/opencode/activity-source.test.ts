/**
 * `ActivitySource` implementation for OpenCode (opencode-activity-source work unit, closing
 * blocker B.1). Unlike the three JSONL harnesses, OpenCode has no file-based session log — this
 * composes `db.ts` (read-only open), `schema-probe.ts` (startup drift check), `poll.ts`
 * (seq-ordered event polling, backoff, checkpoint math) and `parse.ts` (row -> `AgentEvent`
 * mapping) behind the SAME `ActivitySource` port the other three harnesses implement.
 *
 * Every test here builds its own brand-new synthetic scratch db via `test/helpers/opencode-db.ts`
 * — never the real `~/.local/share/opencode/opencode.db`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSyntheticOpenCodeDb,
  dropColumn,
  seedEvent,
  seedPart,
  seedSession,
  type SeedSessionRow,
} from '../../../../test/helpers/opencode-db';
import { OpenCodeActivitySource, type OpenCodeSessionRef } from './activity-source';

const TOOL_PART_DATA = JSON.stringify({ type: 'tool', tool: 'read', state: { title: 'design.md' } });
const MEMORY_WRITE_PART_DATA = JSON.stringify({
  type: 'tool',
  tool: 'engram_mem_save',
  state: { input: { title: 'Synthetic memory write', topic_key: 'probe/topic', type: 'discovery' } },
});

describe('OpenCodeActivitySource', () => {
  let scratchDir: string;

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  function freshDbPath(): string {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-activity-source-'));
    return join(scratchDir, 'opencode.db');
  }

  function seedToolSession(dbPath: string, sessionRow: SeedSessionRow, partData: string): void {
    const writer = buildSyntheticOpenCodeDb(dbPath);
    seedSession(writer, sessionRow);
    seedEvent(writer, { id: 'evt_1', aggregate_id: sessionRow.id, seq: 1, type: 'message.part.updated.1', data: '{}' });
    seedPart(writer, { id: 'prt_1', message_id: 'msg_1', session_id: sessionRow.id, data: partData });
    writer.close();
  }

  describe('discover() (session enumeration from the session table)', () => {
    it('yields a session already present in the db before the source was constructed', async () => {
      const dbPath = freshDbPath();
      seedToolSession(dbPath, { id: 'ses_1', agent: 'observador' }, TOOL_PART_DATA);
      const source = new OpenCodeActivitySource(dbPath);

      const { value: sessionRef } = await source.discover()[Symbol.asyncIterator]().next();

      expect(sessionRef?.sessionKey).toBe('opencode:ses_1');
      await source.close();
    });

    it('does not yield a session whose time_updated is outside the 24h active window', async () => {
      const dbPath = freshDbPath();
      const now = 1_000_000_000_000;
      seedToolSession(
        dbPath,
        { id: 'ses_stale', agent: 'general', time_created: now - 30 * 60 * 60 * 1000, time_updated: now - 30 * 60 * 60 * 1000 },
        TOOL_PART_DATA,
      );
      const source = new OpenCodeActivitySource(dbPath, { now: () => now });

      const iterator = source.discover()[Symbol.asyncIterator]();
      const result = await Promise.race([
        iterator.next().then((r) => r),
        new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 30)),
      ]);

      expect(result.value).toBeUndefined();
      await source.close();
    });
  });

  describe('quiet degradation (invariant: missing/drifted db never crashes, degrades quietly)', () => {
    it('discover() yields nothing when the db file does not exist', async () => {
      scratchDir = mkdtempSync(join(tmpdir(), 'opencode-activity-source-'));
      const dbPath = join(scratchDir, 'does-not-exist.db');
      const source = new OpenCodeActivitySource(dbPath);

      const iterator = source.discover()[Symbol.asyncIterator]();
      const result = await Promise.race([
        iterator.next(),
        new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 30)),
      ]);

      expect(result.value).toBeUndefined();
      await expect(source.probe()).resolves.toMatchObject({ status: 'disabled' });
      await source.close();
    });

    it('discover() yields nothing when the schema is drifted (session.agent dropped)', async () => {
      const dbPath = freshDbPath();
      const writer = buildSyntheticOpenCodeDb(dbPath);
      seedSession(writer, { id: 'ses_1' });
      dropColumn(writer, 'session', 'agent');
      writer.close();
      const source = new OpenCodeActivitySource(dbPath);

      const iterator = source.discover()[Symbol.asyncIterator]();
      const result = await Promise.race([
        iterator.next(),
        new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 30)),
      ]);

      expect(result.value).toBeUndefined();
      await expect(source.probe()).resolves.toMatchObject({ status: 'disabled', reason: 'schema_drift' });
      await source.close();
    });
  });

  describe('read-only enforcement (adapter must use the read-only guarded open path, never a bypass)', () => {
    it('near-miss twin: -wal AND -shm both present opens ready and discover() yields the session normally', async () => {
      const dbPath = freshDbPath();
      const writer = buildSyntheticOpenCodeDb(dbPath);
      writer.exec('PRAGMA journal_mode=WAL');
      seedSession(writer, { id: 'ses_1', agent: 'general' });
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      const source = new OpenCodeActivitySource(dbPath);

      const { value: sessionRef } = await source.discover()[Symbol.asyncIterator]().next();

      expect(sessionRef?.sessionKey).toBe('opencode:ses_1');
      await source.close();
      writer.close();
    });

    it('degrades quietly (never opens a bypass connection) when -shm is missing while -wal is present', async () => {
      const dbPath = freshDbPath();
      const writer = buildSyntheticOpenCodeDb(dbPath);
      writer.exec('PRAGMA journal_mode=WAL');
      seedSession(writer, { id: 'ses_1', agent: 'general' });
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      rmSync(`${dbPath}-shm`);
      const source = new OpenCodeActivitySource(dbPath);

      const iterator = source.discover()[Symbol.asyncIterator]();
      const result = await Promise.race([
        iterator.next(),
        new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 30)),
      ]);

      expect(result.value).toBeUndefined();
      await expect(source.probe()).resolves.toMatchObject({ status: 'disabled', reason: 'wal_shm_unavailable' });
      await source.close();
      writer.close();
    });
  });

  describe('open() — bootstrap + live poll of tool_start/memory_write through the seq/part pipeline', () => {
    it('emits session_start first, then tool_start for a pre-existing tool part (bootstrap read from checkpoint null)', async () => {
      const dbPath = freshDbPath();
      seedToolSession(dbPath, { id: 'ses_1', agent: 'general' }, TOOL_PART_DATA);
      const source = new OpenCodeActivitySource(dbPath, { cadenceMs: 20 });

      const { value: sessionRef } = await source.discover()[Symbol.asyncIterator]().next();
      const stream = source.open(sessionRef as OpenCodeSessionRef, null);
      const iterator = stream.events[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.value?.event.kind).toBe('session_start');
      expect(first.value?.event.label).toBe('general');

      const second = await iterator.next();
      expect(second.value?.event.kind).toBe('tool_start');
      expect(second.value?.event).toMatchObject({ toolLabel: 'read', toolDetail: 'design.md', harness: 'opencode' });

      stream.stop();
      await source.close();
    });

    it('emits memory_write IN ADDITION TO tool_start for a pre-existing engram_mem_save part', async () => {
      const dbPath = freshDbPath();
      seedToolSession(dbPath, { id: 'ses_1', agent: 'general' }, MEMORY_WRITE_PART_DATA);
      const source = new OpenCodeActivitySource(dbPath, { cadenceMs: 20 });

      const { value: sessionRef } = await source.discover()[Symbol.asyncIterator]().next();
      const stream = source.open(sessionRef as OpenCodeSessionRef, null);
      const iterator = stream.events[Symbol.asyncIterator]();

      await iterator.next(); // session_start
      const toolStart = await iterator.next();
      expect(toolStart.value?.event.kind).toBe('tool_start');
      const memoryWrite = await iterator.next();
      expect(memoryWrite.value?.event).toMatchObject({
        kind: 'memory_write',
        harness: 'opencode',
        sessionKey: 'opencode:ses_1',
        title: 'Synthetic memory write',
        topicKey: 'probe/topic',
        toolLabel: 'engram_mem_save',
      });

      stream.stop();
      await source.close();
    });

    it('emits a parent event correlated to the parent session key, alongside the child session_start', async () => {
      const dbPath = freshDbPath();
      const writer = buildSyntheticOpenCodeDb(dbPath);
      seedSession(writer, { id: 'ses_parent', agent: 'general' });
      seedSession(writer, { id: 'ses_child', parent_id: 'ses_parent', agent: 'observador' });
      seedEvent(writer, { id: 'evt_1', aggregate_id: 'ses_child', seq: 1, type: 'session.created.1', data: '{}' });
      writer.close();
      const source = new OpenCodeActivitySource(dbPath, { cadenceMs: 20 });

      const childRef: OpenCodeSessionRef = { harness: 'opencode', sessionKey: 'opencode:ses_child', discoveredAt: 0, sessionId: 'ses_child' };
      const stream = source.open(childRef, null);
      const iterator = stream.events[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.value?.event.kind).toBe('session_start');
      const second = await iterator.next();
      expect(second.value?.event).toMatchObject({ kind: 'parent', correlationId: 'opencode:ses_parent' });

      stream.stop();
      await source.close();
    });

    it('live-poll: picks up a part row written AFTER open() was called', async () => {
      const dbPath = freshDbPath();
      const writer = buildSyntheticOpenCodeDb(dbPath);
      seedSession(writer, { id: 'ses_1', agent: 'general' });
      // `writer` stays open for the whole test, simulating a live OpenCode process.
      const source = new OpenCodeActivitySource(dbPath, { cadenceMs: 15 });

      const sessionRef: OpenCodeSessionRef = { harness: 'opencode', sessionKey: 'opencode:ses_1', discoveredAt: 0, sessionId: 'ses_1' };
      const stream = source.open(sessionRef, null);
      const iterator = stream.events[Symbol.asyncIterator]();

      const sessionStart = await iterator.next();
      expect(sessionStart.value?.event.kind).toBe('session_start');

      seedEvent(writer, { id: 'evt_1', aggregate_id: 'ses_1', seq: 1, type: 'message.part.updated.1', data: '{}' });
      seedPart(writer, { id: 'prt_1', message_id: 'msg_1', session_id: 'ses_1', data: TOOL_PART_DATA });

      const toolStart = await iterator.next();
      expect(toolStart.value?.event.kind).toBe('tool_start');

      stream.stop();
      await source.close();
      writer.close();
    });

    it('resumes from a persisted seq checkpoint instead of re-emitting already-processed content', async () => {
      const dbPath = freshDbPath();
      seedToolSession(dbPath, { id: 'ses_1', agent: 'general' }, TOOL_PART_DATA);
      const source = new OpenCodeActivitySource(dbPath, { cadenceMs: 20 });

      const sessionRef: OpenCodeSessionRef = { harness: 'opencode', sessionKey: 'opencode:ses_1', discoveredAt: 0, sessionId: 'ses_1' };
      const stream = source.open(sessionRef, { kind: 'seq', bySession: { ses_1: 1 } });
      const iterator = stream.events[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.value?.event.kind).toBe('session_start');

      // No further items should arrive quickly: the only event (seq 1) is already checkpointed.
      const raceResult = await Promise.race([
        iterator.next().then((r) => ({ arrived: true, kind: r.value?.event.kind })),
        new Promise<{ arrived: false }>((resolve) => setTimeout(() => resolve({ arrived: false }), 60)),
      ]);
      expect(raceResult.arrived).toBe(false);

      stream.stop();
      await source.close();
    });
  });

  describe('no dangling timer after close() (adversarial: a broken cancellation would leave a pending timer)', () => {
    it('cancels every pending poll/discovery timer synchronously when close() is called', async () => {
      vi.useFakeTimers();
      try {
        const dbPath = freshDbPath();
        seedToolSession(dbPath, { id: 'ses_1', agent: 'general' }, TOOL_PART_DATA);
        const source = new OpenCodeActivitySource(dbPath, { cadenceMs: 500 });

        const sessionIterator = source.discover()[Symbol.asyncIterator]();
        const { value: sessionRef } = await sessionIterator.next();
        const stream = source.open(sessionRef as OpenCodeSessionRef, null);
        const eventIterator = stream.events[Symbol.asyncIterator]();
        await eventIterator.next(); // session_start
        await eventIterator.next(); // tool_start (bootstrap)

        // The per-session pump is now asleep awaiting the next cadence tick.
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        stream.stop();
        await source.close();

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Zero-Write Invariant (composition level): discover + open + close never mutates the db', () => {
    it('leaves db and -wal byte-identical; -shm keeps its size and is never deleted', async () => {
      const dbPath = freshDbPath();
      const writer = buildSyntheticOpenCodeDb(dbPath);
      writer.exec('PRAGMA journal_mode=WAL');
      seedSession(writer, { id: 'ses_1', agent: 'general' });
      seedEvent(writer, { id: 'evt_1', aggregate_id: 'ses_1', seq: 1, type: 'message.part.updated.1', data: '{}' });
      seedPart(writer, { id: 'prt_1', message_id: 'msg_1', session_id: 'ses_1', data: TOOL_PART_DATA });
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

      const source = new OpenCodeActivitySource(dbPath, { cadenceMs: 20 });
      const { value: sessionRef } = await source.discover()[Symbol.asyncIterator]().next();
      const stream = source.open(sessionRef as OpenCodeSessionRef, null);
      const iterator = stream.events[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      stream.stop();
      await source.close();

      // `writer` stays open (matching poll.test.ts's own Threat Matrix case h precedent) until
      // AFTER the "after" snapshot: closing the LAST WAL connection triggers SQLite's own final
      // checkpoint/-wal cleanup, which would otherwise be misread as something THIS adapter did.
      const after = snapshot();
      writer.close();
      expect(after.db).toEqual(before.db);
      expect(after.wal).toEqual(before.wal);
      expect(after.shmExists).toBe(true);
      expect(after.shmSize).toBe(before.shmSize);
    });
  });

  describe('probe()', () => {
    it('returns ready for a healthy db', async () => {
      const dbPath = freshDbPath();
      seedToolSession(dbPath, { id: 'ses_1', agent: 'general' }, TOOL_PART_DATA);
      const source = new OpenCodeActivitySource(dbPath);

      await expect(source.probe()).resolves.toEqual({ status: 'ready' });
      await source.close();
    });
  });
});
