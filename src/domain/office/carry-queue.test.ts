import { describe, expect, it } from 'vitest';
import {
  completeHeldCarryJob,
  createCarryQueueState,
  enqueueCarryJob,
  type CarryQueueState,
} from './carry-queue';

const WORKER = 'claude-code:s1';

function enqueueMany(state: CarryQueueState, count: number, startAt: number): CarryQueueState {
  let next = state;
  for (let i = 0; i < count; i++) {
    next = enqueueCarryJob(next, WORKER, startAt + i);
  }
  return next;
}

describe('carry-queue (design.md: "animation is a lagging view, ingestion never blocks")', () => {
  it('holds the first memory_write immediately — nothing queued, no batch', () => {
    const state = enqueueCarryJob(createCarryQueueState(), WORKER, 1000);

    expect(state.held).toMatchObject({ sessionKey: WORKER, queuedAt: 1000, count: 1 });
    expect(state.queued).toEqual([]);
    expect(state.batch).toBeNull();
  });

  it('queues a second memory_write FIFO behind the held document, below the collapse threshold', () => {
    const state = enqueueMany(createCarryQueueState(), 2, 1000);

    expect(state.held).toMatchObject({ count: 1 });
    expect(state.queued).toHaveLength(1);
    expect(state.batch).toBeNull();
  });

  // Task 20.2 (fake-clock): 6 queued memory_write events for one worker collapse to
  // 1 held + 1 batch(×5).
  it('collapses 6 total memory_write events into 1 held + 1 batch(×5)', () => {
    const state = enqueueMany(createCarryQueueState(), 6, 2000);

    expect(state.held).toMatchObject({ sessionKey: WORKER, count: 1 });
    expect(state.queued).toEqual([]);
    expect(state.batch).toMatchObject({ count: 5 });
  });

  // Adversarial boundary twin for the same guard: exactly 5 total events (one fewer) must NOT
  // collapse — proves the collapse threshold triggers at 6, not before.
  it('does NOT collapse at exactly 5 total memory_write events (one below the 6-event boundary)', () => {
    const state = enqueueMany(createCarryQueueState(), 5, 2000);

    expect(state.held).toMatchObject({ count: 1 });
    expect(state.queued).toHaveLength(4);
    expect(state.batch).toBeNull();
  });

  it('further memory_write events after a batch has formed increment the existing batch, never a second batch', () => {
    let state = enqueueMany(createCarryQueueState(), 6, 3000);
    expect(state.batch).toMatchObject({ count: 5 });

    state = enqueueCarryJob(state, WORKER, 3010);

    expect(state.batch).toMatchObject({ count: 6 });
    expect(state.queued).toEqual([]);
  });

  it('promotes the pending batch whole (×N) once the held carry completes', () => {
    let state = enqueueMany(createCarryQueueState(), 6, 4000);
    state = completeHeldCarryJob(state);

    expect(state.held).toMatchObject({ sessionKey: WORKER, count: 5 });
    expect(state.queued).toEqual([]);
    expect(state.batch).toBeNull();
  });

  it('promotes the next FIFO queued job when no batch has formed', () => {
    let state = enqueueMany(createCarryQueueState(), 3, 5000); // held + 2 queued
    state = completeHeldCarryJob(state);

    expect(state.held).toMatchObject({ count: 1 });
    expect(state.queued).toHaveLength(1);
  });

  it('leaves nothing held once the queue and batch are both empty', () => {
    let state = enqueueCarryJob(createCarryQueueState(), WORKER, 6000);
    state = completeHeldCarryJob(state);

    expect(state.held).toBeNull();
    expect(state.queued).toEqual([]);
    expect(state.batch).toBeNull();
  });

  it('completing an already-empty queue is a safe no-op', () => {
    const state = createCarryQueueState();
    expect(completeHeldCarryJob(state)).toEqual(state);
  });
});
