import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficeContainer } from './OfficeContainer';
import { OfficeStage, type OfficeRenderer } from '../scene/OfficeStage';
import type { OfficeViewModel } from '../state/office-view-model';
import type { AgentEvent } from '../../domain/events/types';
import { createEventFromLogRecord } from '../../domain/events/factories';
import { resolveWorkerLabel, type ClaudeCodeRecord } from '../../adapters/driven/claude-code/parse';
import type { StreamConnection, StreamConnectionFactory, StreamMessage } from './OfficeContainer';
import { DOCK_DURATION_MS, WALK_DURATION_MS } from '../scene/animation/trip-animation';
import { PERSISTENT_MEMORY } from '../scene/world/office-map';

class RecordingRenderer implements OfficeRenderer {
  updates: OfficeViewModel[] = [];
  render(viewModel: OfficeViewModel): void {
    this.updates.push(viewModel);
  }
  get latest(): OfficeViewModel {
    return this.updates[this.updates.length - 1]!;
  }
}

/** A fake, fully controllable `StreamConnection` for driving the container in tests. */
class FakeStreamConnection implements StreamConnection, StreamConnectionFactory {
  private handler: ((message: StreamMessage) => void) | null = null;
  closed = false;

  connect(): StreamConnection {
    return this;
  }
  onMessage(handler: (message: StreamMessage) => void): void {
    this.handler = handler;
  }
  close(): void {
    this.closed = true;
  }
  emit(message: StreamMessage): void {
    this.handler?.(message);
  }
}

function sessionStart(id: number, sessionKey: string, label?: string): AgentEvent {
  return createEventFromLogRecord(id, { kind: 'session_start', harness: 'claude-code', sessionKey, at: id, label });
}

function sessionEnd(id: number, sessionKey: string): AgentEvent {
  return createEventFromLogRecord(id, { kind: 'session_end', harness: 'claude-code', sessionKey, at: id });
}

function parentEvent(id: number, sessionKey: string, correlationId: string): AgentEvent {
  return createEventFromLogRecord(id, { kind: 'parent', harness: 'claude-code', sessionKey, at: id, correlationId });
}

function memoryWriteEvent(id: number, sessionKey: string): AgentEvent {
  return { id, kind: 'memory_write', harness: 'claude-code', sessionKey, at: id, toolLabel: 'mem_save' };
}

function toolStartEvent(id: number, sessionKey: string): AgentEvent {
  return createEventFromLogRecord(id, { kind: 'tool_start', harness: 'claude-code', sessionKey, at: id, toolLabel: 'Read' });
}

describe('OfficeContainer (tasks.md 10.4) — owns the SSE subscription and client projection', () => {
  it('a worker appears on session_start and disappears on session_end (office-scene-renderer spec)', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    connection.emit({ kind: 'event', event: sessionStart(1, 'claude-code:s1', 'my-session') });
    expect(renderer.latest.workers.map((w) => w.sessionKey)).toEqual(['claude-code:s1']);

    connection.emit({ kind: 'event', event: sessionEnd(2, 'claude-code:s1') });
    expect(renderer.latest.workers).toEqual([]);
  });

  it('a Claude subagent renders in a visually distinct lane from its parent (Parent/Child Lane Layout)', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    connection.emit({ kind: 'event', event: sessionStart(1, 'claude-code:parent1') });
    connection.emit({ kind: 'event', event: sessionStart(2, 'claude-code:child1') });
    connection.emit({ kind: 'event', event: parentEvent(3, 'claude-code:child1', 'claude-code:parent1') });

    // The room's desks are the artist's, not ours, so a subagent no longer gets its own lane —
    // but it must still get its own workstation, never share its parent's.
    const parentWorker = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:parent1');
    const childWorker = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:child1');
    expect(parentWorker?.stationId).toBeDefined();
    expect(childWorker?.stationId).not.toBe(parentWorker?.stationId);
    expect({ x: childWorker?.x, y: childWorker?.y }).not.toEqual({ x: parentWorker?.x, y: parentWorker?.y });
  });

  it('a snapshot frame replaces the projected state wholesale', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    connection.emit({ kind: 'event', event: sessionStart(1, 'claude-code:stale') });
    expect(renderer.latest.workers.map((w) => w.sessionKey)).toEqual(['claude-code:stale']);

    connection.emit({
      kind: 'snapshot',
      snapshot: {
        generatedAt: 1000,
        workers: [{ sessionKey: 'claude-code:fresh', harness: 'claude-code', label: 'fresh', activity: 'working', parentSessionKey: null }],
        archive: { slots: [], waitQueue: [], nextSlotCursor: 0 },
        carryQueues: [],
      },
    });

    expect(renderer.latest.workers.map((w) => w.sessionKey)).toEqual(['claude-code:fresh']);
  });

  // G.1: "the snapshot frame carries no archive state" — a late-connecting client must reconstruct
  // archive docking + in-flight carry queues from the snapshot, not just workers.
  it('a snapshot carrying archive + carry-queue state reconstructs an in-flight archive trip (G.1)', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    connection.emit({
      kind: 'snapshot',
      snapshot: {
        generatedAt: 1000,
        workers: [{ sessionKey: 'claude-code:w1', harness: 'claude-code', label: 'w1', activity: 'working', parentSessionKey: null }],
        archive: {
          slots: [
            { slotIndex: 0, occupiedBySessionKey: 'claude-code:w1' },
            { slotIndex: 1, occupiedBySessionKey: null },
            { slotIndex: 2, occupiedBySessionKey: null },
            { slotIndex: 3, occupiedBySessionKey: null },
          ],
          waitQueue: [],
          nextSlotCursor: 1,
        },
        carryQueues: [
          {
            sessionKey: 'claude-code:w1',
            queue: { held: { sessionKey: 'claude-code:w1', queuedAt: 500, count: 1 }, queued: [], batch: null },
          },
        ],
      },
    });

    const worker = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:w1');
    expect(worker?.archiveTrip).toBeDefined();
    expect(worker?.archiveTrip?.carryCount).toBe(1);
  });

  // Adversarial near-miss: the SAME worker with an EMPTY carry queue (no held document) must NOT
  // get an archiveTrip — proving the test above is exercising the real held-document path, not a
  // trivial "any worker gets archiveTrip" pass-through.
  it('adversarial near-miss: a snapshot with an empty carry queue produces NO archive trip', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    connection.emit({
      kind: 'snapshot',
      snapshot: {
        generatedAt: 1000,
        workers: [{ sessionKey: 'claude-code:w1', harness: 'claude-code', label: 'w1', activity: 'working', parentSessionKey: null }],
        archive: { slots: [], waitQueue: [], nextSlotCursor: 0 },
        carryQueues: [],
      },
    });

    const worker = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:w1');
    expect(worker?.archiveTrip).toBeUndefined();
  });

  it('disconnect closes the underlying stream connection', () => {
    const connection = new FakeStreamConnection();
    const container = new OfficeContainer(connection, new OfficeStage(new RecordingRenderer()));
    container.connect();

    container.disconnect();

    expect(connection.closed).toBe(true);
  });

  it('worker label resolution fallback chain flows end to end into the rendered caption (Worker Label Resolution)', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    const withAttribution: ClaudeCodeRecord = { attributionAgent: 'explicit-agent' };
    const withDescriptionOnly: ClaudeCodeRecord = { toolUseResult: { description: 'described-agent' } };
    const withNeither: ClaudeCodeRecord = {};

    const labelA = resolveWorkerLabel(withAttribution, null);
    const labelB = resolveWorkerLabel(withDescriptionOnly, null);
    const labelC = resolveWorkerLabel(withNeither, 'abcdef1234567890');

    connection.emit({ kind: 'event', event: sessionStart(1, 'claude-code:a', labelA) });
    connection.emit({ kind: 'event', event: sessionStart(2, 'claude-code:b', labelB) });
    connection.emit({ kind: 'event', event: sessionStart(3, 'claude-code:c', labelC) });

    const byKey = new Map(renderer.latest.workers.map((w) => [w.sessionKey, w.label]));
    expect(byKey.get('claude-code:a')).toBe('explicit-agent');
    expect(byKey.get('claude-code:b')).toBe('described-agent');
    expect(byKey.get('claude-code:c')).toBe('agent-abcdef12');
  });
});

describe('OfficeContainer — archive-trip animation (blocker B.2, tasks.md 21.2)', () => {
  it('a memory_write event immediately projects an archiveTrip, before any animation tick runs', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    connection.emit({ kind: 'event', event: sessionStart(1, 'claude-code:s1') });
    connection.emit({ kind: 'event', event: memoryWriteEvent(2, 'claude-code:s1') });

    const worker = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:s1');
    expect(worker?.archiveTrip).toBeDefined();
  });

  // The hard requirement from task 21.2: ingestion must never block or lag behind animation
  // playback. A burst of memory_write events for many distinct workers, fired back-to-back with
  // NO tick() call in between, must ALL be reflected in the model instantly — regardless of how
  // slow, busy, or mid-flight the animation is (here: not even started). Capped at
  // MAX_PACKED_WORKERS (8, office-layout.ts) — beyond that a worker legitimately gets no desk at
  // all, an unrelated layout concern this test does not exercise.
  it('ingestion never blocks: a burst of memory_write events for 8 workers is fully reflected with zero animation ticks', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    let id = 0;
    for (let i = 0; i < 8; i++) {
      connection.emit({ kind: 'event', event: sessionStart(++id, `claude-code:burst-${i}`) });
      connection.emit({ kind: 'event', event: memoryWriteEvent(++id, `claude-code:burst-${i}`) });
    }

    expect(renderer.latest.workers).toHaveLength(8);
    for (const worker of renderer.latest.workers) {
      expect(worker.archiveTrip).toBeDefined();
      expect(worker.archiveTrip?.carryCount).toBe(1);
    }
    // No tick() was ever called: no worker has moved off its desk, and the archive counter is
    // still untouched — animation genuinely lags behind ingestion, it does not race it.
    expect(renderer.latest.archiveCount ?? 0).toBe(0);
  });

  it('tick() walks the worker toward the archive over time, without any new ingested event', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    connection.emit({ kind: 'event', event: sessionStart(1, 'claude-code:s1') });
    connection.emit({ kind: 'event', event: memoryWriteEvent(2, 'claude-code:s1') });
    const desk = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:s1')!;

    container.tick(0);
    container.tick(WALK_DURATION_MS / 2);

    const midway = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:s1')!;
    expect(midway.x === desk.x && midway.y === desk.y).toBe(false);
  });

  it('tick() reaches the archive, highlights, increments the counter, then returns the worker home', () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    connection.emit({ kind: 'event', event: sessionStart(1, 'claude-code:s1') });
    connection.emit({ kind: 'event', event: memoryWriteEvent(2, 'claude-code:s1') });
    const desk = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:s1')!;

    container.tick(0);
    container.tick(WALK_DURATION_MS);

    const atArchive = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:s1')!;
    expect(atArchive.x).toBe(PERSISTENT_MEMORY.anchor.x);
    expect(atArchive.y).toBe(PERSISTENT_MEMORY.anchor.y);
    expect(atArchive.archiveTrip?.highlight).toBe(true);
    expect(renderer.latest.archiveCount).toBe(1);

    container.tick(WALK_DURATION_MS + DOCK_DURATION_MS + WALK_DURATION_MS);

    const returned = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:s1')!;
    expect(returned.x).toBe(desk.x);
    expect(returned.y).toBe(desk.y);
    expect(returned.archiveTrip).toBeUndefined();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The sharpest form of the "ingestion never blocks" guard: real wall-clock time advances past a
  // FULL round trip's worth of animation BETWEEN two ingested events, with `tick()` never called
  // even once. If `handleMessage` ever fed the system clock into the animator (e.g. calling
  // `tick(Date.now())` internally), this second event's render would show the first worker's trip
  // already mid-flight or complete — it must not. Ingestion is driven only by the ingested
  // events' OWN `at` field and `OfficeContainer`'s own `lastTickAt`, never the wall clock.
  it('a real-time gap between two ingested events never advances animation without an explicit tick()', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const container = new OfficeContainer(connection, new OfficeStage(renderer));
    container.connect();

    // A bystander session established FIRST, so the desk layout is already stable multi-agent
    // before `desk` is captured below — an unrelated `tool_start` on it later re-renders without
    // perturbing anyone's desk position.
    connection.emit({ kind: 'event', event: sessionStart(1, 'claude-code:bystander') });
    connection.emit({ kind: 'event', event: sessionStart(2, 'claude-code:s1') });
    connection.emit({ kind: 'event', event: memoryWriteEvent(3, 'claude-code:s1') });
    const desk = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:s1')!;

    vi.setSystemTime(WALK_DURATION_MS + DOCK_DURATION_MS + WALK_DURATION_MS + 1000);
    connection.emit({ kind: 'event', event: toolStartEvent(4, 'claude-code:bystander') });

    const worker = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:s1')!;
    expect(worker.archiveTrip).toBeDefined();
    expect(worker.archiveTrip?.highlight).not.toBe(true);
    expect(worker.x).toBe(desk.x);
    expect(worker.y).toBe(desk.y);
  });
});

// tasks.md 26.2: the launcher UI control is wired through OfficeContainer.
describe('OfficeContainer.requestLaunch', () => {
  it('delegates to the injected LaunchClient and returns its result unchanged', async () => {
    const connection = new FakeStreamConnection();
    const renderer = new RecordingRenderer();
    const stage = new OfficeStage(renderer);
    const expected = { outcome: 'started' as const, launchId: 'l1', pid: 1, startedAt: 0 };
    let received: unknown = null;
    const launchClient = {
      requestLaunch: async (spec: unknown) => {
        received = spec;
        return expected;
      },
    };
    const container = new OfficeContainer(connection, stage, launchClient);
    const spec = { harness: 'claude-code' as const, cwd: '/tmp', args: [] };

    const result = await container.requestLaunch(spec);

    expect(result).toBe(expected);
    expect(received).toBe(spec);
  });
});
