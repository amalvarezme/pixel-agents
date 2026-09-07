import { describe, expect, it } from 'vitest';
import { appendToRing, createRingBuffer, planReplay, RING_CAPACITY } from './ring-buffer';
import type { AgentEvent } from '../../../domain/events/types';

function event(id: number): AgentEvent {
  return { id, kind: 'tool_start', harness: 'claude-code', sessionKey: 'claude-code:s1', at: id * 1000 };
}

describe('ring buffer (tasks.md 9.2)', () => {
  it('replays only events strictly after a Last-Event-ID still inside the ring', () => {
    let ring = createRingBuffer();
    for (let id = 1; id <= 5; id++) ring = appendToRing(ring, event(id));

    const plan = planReplay(ring, 3);

    expect(plan.status).toBe('replay');
    expect(plan.status === 'replay' ? plan.events.map((e) => e.id) : []).toEqual([4, 5]);
  });

  it('requires a snapshot when no Last-Event-ID is given (first connect)', () => {
    let ring = createRingBuffer();
    ring = appendToRing(ring, event(1));

    const plan = planReplay(ring, null);

    expect(plan.status).toBe('snapshot');
  });

  it('requires a snapshot when the requested id was evicted from the ring', () => {
    let ring = createRingBuffer(3);
    for (let id = 1; id <= 5; id++) ring = appendToRing(ring, event(id));
    // capacity 3 keeps ids [3,4,5]; id=1 is evicted.

    const plan = planReplay(ring, 1);

    expect(plan.status).toBe('snapshot');
  });

  it('a gap left by eviction (missing at least one id) forces a snapshot, not a replay', () => {
    let ring = createRingBuffer(2);
    for (let id = 1; id <= 4; id++) ring = appendToRing(ring, event(id));
    // capacity 2 keeps ids [3,4]; ids 1 and 2 were evicted.

    const planWithGap = planReplay(ring, 1);
    expect(planWithGap.status).toBe('snapshot');

    const planNoGap = planReplay(ring, 2);
    expect(planNoGap.status === 'replay' ? planNoGap.events.map((e) => e.id) : []).toEqual([3, 4]);
  });

  it('exposes the default capacity as 2000 (design.md D2: ring buffer of the last 2000 events)', () => {
    expect(RING_CAPACITY).toBe(2000);
  });
});
