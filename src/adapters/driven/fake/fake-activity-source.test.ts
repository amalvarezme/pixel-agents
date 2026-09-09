import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../domain/events/types';
import { FakeActivitySource } from './fake-activity-source';

function event(id: number, sessionKey: string): AgentEvent {
  return { id, kind: 'tool_start', harness: 'claude-code', sessionKey, at: id * 1000 };
}

// Requirement (tasks.md 5.1): one fake ActivitySource, in-memory, no I/O, proving
// discover()/open()/close() end-to-end — this is the seam the four real adapters (slices
// 1b-3) will each implement against.
describe('FakeActivitySource', () => {
  it('discovers every scripted session', async () => {
    const source = new FakeActivitySource('claude-code', [
      { session: { harness: 'claude-code', sessionKey: 'claude-code:s1', cwd: null, discoveredAt: 0 }, events: [] },
      { session: { harness: 'claude-code', sessionKey: 'claude-code:s2', cwd: null, discoveredAt: 0 }, events: [] },
    ]);

    const discovered: string[] = [];
    for await (const session of source.discover()) {
      discovered.push(session.sessionKey);
    }

    expect(discovered).toEqual(['claude-code:s1', 'claude-code:s2']);
  });

  it('open() replays scripted events in order from the start when no checkpoint is given', async () => {
    const sessionRef = { harness: 'claude-code' as const, sessionKey: 'claude-code:s1', cwd: null, discoveredAt: 0 };
    const source = new FakeActivitySource('claude-code', [
      { session: sessionRef, events: [event(1, 'claude-code:s1'), event(2, 'claude-code:s1')] },
    ]);

    const stream = source.open(sessionRef, null);
    const received: number[] = [];
    for await (const item of stream.events) {
      received.push(item.event.id);
    }

    expect(received).toEqual([1, 2]);
  });

  it('open() resumes from a seq checkpoint, skipping already-published events', async () => {
    const sessionRef = { harness: 'claude-code' as const, sessionKey: 'claude-code:s1', cwd: null, discoveredAt: 0 };
    const source = new FakeActivitySource('claude-code', [
      { session: sessionRef, events: [event(1, 'claude-code:s1'), event(2, 'claude-code:s1'), event(3, 'claude-code:s1')] },
    ]);

    const stream = source.open(sessionRef, { kind: 'seq', bySession: { 'claude-code:s1': 1 } });
    const received: number[] = [];
    for await (const item of stream.events) {
      received.push(item.event.id);
    }

    expect(received).toEqual([2, 3]);
  });

  it('close() marks the source closed and probe() reports ready', async () => {
    const source = new FakeActivitySource('codex', []);

    expect(await source.probe()).toEqual({ status: 'ready' });
    expect(source.isClosed()).toBe(false);

    await source.close();

    expect(source.isClosed()).toBe(true);
  });
});
