import { describe, expect, it } from 'vitest';
import { OfficeContainer } from './OfficeContainer';
import { OfficeStage, type OfficeRenderer } from '../scene/OfficeStage';
import type { OfficeViewModel } from '../state/office-view-model';
import type { AgentEvent } from '../../domain/events/types';
import { createEventFromLogRecord } from '../../domain/events/factories';
import { resolveWorkerLabel, type ClaudeCodeRecord } from '../../adapters/driven/claude-code/parse';
import type { StreamConnection, StreamConnectionFactory, StreamMessage } from './OfficeContainer';

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

    const parentWorker = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:parent1');
    const childWorker = renderer.latest.workers.find((w) => w.sessionKey === 'claude-code:child1');
    expect(parentWorker?.lane).toBe('root');
    expect(childWorker?.lane).toBe('child');
    expect(childWorker?.y).not.toBe(parentWorker?.y);
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
      },
    });

    expect(renderer.latest.workers.map((w) => w.sessionKey)).toEqual(['claude-code:fresh']);
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
