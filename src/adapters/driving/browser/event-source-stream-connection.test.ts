import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../domain/events/types';
import type { StreamMessage } from '../../../ui/containers/OfficeContainer';
import { EventSourceStreamConnection, type EventSourceLike, type EventSourceStreamOptions } from './event-source-stream-connection';

interface RecordedListener {
  (event: { data: string; lastEventId: string }): void;
}

/** A fully controllable fake standing in for the browser's native `EventSource`. */
class FakeEventSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, RecordedListener[]>();

  addEventListener(type: string, listener: RecordedListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { data: string; lastEventId?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: event.data, lastEventId: event.lastEventId ?? '' });
    }
  }

  triggerOpen(): void {
    this.onopen?.();
  }

  triggerError(): void {
    this.onerror?.();
  }
}

function agentEvent(id: number): AgentEvent {
  return { id, kind: 'tool_start', harness: 'claude-code', sessionKey: 'claude-code:s1', at: id * 1000 };
}

describe('EventSourceStreamConnection (browser-entrypoint work unit) — real StreamConnection backed by EventSource', () => {
  let createdSources: Array<{ url: string; source: FakeEventSource }>;

  function createEventSource(url: string): EventSourceLike {
    const source = new FakeEventSource();
    createdSources.push({ url, source });
    return source;
  }

  beforeEach(() => {
    createdSources = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeConnection(overrides: Partial<EventSourceStreamOptions> = {}) {
    return new EventSourceStreamConnection({
      createEventSource,
      baseUrl: '/stream',
      random: () => 1, // deterministic "full jitter": always the max of the current backoff window
      ...overrides,
    });
  }

  it('connect() opens exactly one EventSource against the given base URL, with no lastEventId on first connect', () => {
    const connection = makeConnection();

    connection.connect();

    expect(createdSources).toHaveLength(1);
    expect(createdSources[0]!.url).toBe('/stream');
  });

  it('a bare "message" frame is projected into a StreamMessage carrying the parsed AgentEvent', () => {
    const connection = makeConnection();
    const received: StreamMessage[] = [];
    connection.onMessage((message) => received.push(message));
    connection.connect();

    createdSources[0]!.source.emit('message', { data: JSON.stringify(agentEvent(1)), lastEventId: '1' });

    expect(received).toEqual([{ kind: 'event', event: agentEvent(1) }]);
  });

  it('a named "snapshot" frame is projected into a snapshot StreamMessage', () => {
    const connection = makeConnection();
    const received: StreamMessage[] = [];
    connection.onMessage((message) => received.push(message));
    connection.connect();

    const snapshot = { generatedAt: 123, workers: [] };
    createdSources[0]!.source.emit('snapshot', { data: JSON.stringify(snapshot) });

    expect(received).toEqual([{ kind: 'snapshot', snapshot }]);
  });

  it('a named "snapshot_required" frame is forwarded AND forces a reconnect with the lastEventId dropped', () => {
    const connection = makeConnection();
    const received: StreamMessage[] = [];
    connection.onMessage((message) => received.push(message));
    connection.connect();

    createdSources[0]!.source.emit('message', { data: JSON.stringify(agentEvent(5)), lastEventId: '5' });
    createdSources[0]!.source.emit('snapshot_required', { data: '{}' });

    expect(received.at(-1)).toEqual({ kind: 'snapshot_required' });
    expect(createdSources[0]!.source.closed).toBe(true);

    vi.advanceTimersByTime(1000); // base backoff (random()=1 -> full window)
    expect(createdSources).toHaveLength(2);
    expect(createdSources[1]!.url).toBe('/stream'); // no ?lastEventId= — dropped on desync
  });

  it('resumes with ?lastEventId= (a query parameter, since a manually re-created EventSource cannot set the header) on reconnect after an error', () => {
    const connection = makeConnection();
    connection.onMessage(() => {});
    connection.connect();

    createdSources[0]!.source.emit('message', { data: JSON.stringify(agentEvent(7)), lastEventId: '7' });
    createdSources[0]!.source.triggerError();

    vi.advanceTimersByTime(1000);

    expect(createdSources).toHaveLength(2);
    expect(createdSources[1]!.url).toBe('/stream?lastEventId=7');
  });

  it('backs off exponentially (1s, 2s, 4s...) on repeated errors, capped at maxBackoffMs', () => {
    const connection = makeConnection({ maxBackoffMs: 5000 });
    connection.onMessage(() => {});
    connection.connect();

    createdSources[0]!.source.triggerError();
    vi.advanceTimersByTime(999);
    expect(createdSources).toHaveLength(1); // not yet — backoff is 1000ms
    vi.advanceTimersByTime(1);
    expect(createdSources).toHaveLength(2); // fired at 1000ms

    createdSources[1]!.source.triggerError();
    vi.advanceTimersByTime(1999);
    expect(createdSources).toHaveLength(2); // not yet — backoff doubled to 2000ms
    vi.advanceTimersByTime(1);
    expect(createdSources).toHaveLength(3);

    createdSources[2]!.source.triggerError();
    vi.advanceTimersByTime(4000);
    expect(createdSources).toHaveLength(4); // doubled again to 4000ms

    createdSources[3]!.source.triggerError();
    vi.advanceTimersByTime(5000);
    expect(createdSources).toHaveLength(5); // capped at maxBackoffMs (5000), not 8000ms
  });

  it('a successful open() resets backoff to the minimum for the NEXT failure', () => {
    const connection = makeConnection({ maxBackoffMs: 30000 });
    connection.onMessage(() => {});
    connection.connect();

    createdSources[0]!.source.triggerError();
    vi.advanceTimersByTime(1000);
    expect(createdSources).toHaveLength(2); // first failure: 1000ms

    createdSources[1]!.source.triggerOpen(); // recovered — backoff should reset
    createdSources[1]!.source.triggerError();
    vi.advanceTimersByTime(999);
    expect(createdSources).toHaveLength(2); // not yet — back to the 1000ms minimum, not 2000ms
    vi.advanceTimersByTime(1);
    expect(createdSources).toHaveLength(3);
  });

  it('close() stops any pending reconnect and closes the current EventSource', () => {
    const connection = makeConnection();
    connection.onMessage(() => {});
    connection.connect();

    createdSources[0]!.source.triggerError();
    connection.close();

    expect(createdSources[0]!.source.closed).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(createdSources).toHaveLength(1); // the scheduled reconnect never fired
  });
});
