import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_SLOT_COUNT,
  createArchiveDockState,
  releaseArchiveDock,
  requestArchiveDock,
  type ArchiveDockState,
} from './archive-dock';

function slotOf(state: ArchiveDockState, sessionKey: string): number | undefined {
  return state.slots.find((s) => s.occupiedBySessionKey === sessionKey)?.slotIndex;
}

describe('archive-dock (design.md: "the archive has 4 docking slots assigned round-robin")', () => {
  it('has 4 slots, all free, on creation', () => {
    const state = createArchiveDockState();

    expect(ARCHIVE_SLOT_COUNT).toBe(4);
    expect(state.slots).toHaveLength(4);
    expect(state.slots.every((s) => s.occupiedBySessionKey === null)).toBe(true);
  });

  it('assigns the first request to slot 0', () => {
    const state = requestArchiveDock(createArchiveDockState(), 'claude-code:w1', 1000);

    expect(slotOf(state, 'claude-code:w1')).toBe(0);
    expect(state.waitQueue).toEqual([]);
  });

  // Task 20.4 (cross-worker concurrency): 5 simultaneous memory_write events — 4 dock
  // immediately, 1 queues.
  it('docks the first 4 concurrent workers immediately; the 5th waits', () => {
    let state = createArchiveDockState();
    for (const worker of ['w1', 'w2', 'w3', 'w4', 'w5']) {
      state = requestArchiveDock(state, worker, 1000);
    }

    expect(slotOf(state, 'w1')).toBe(0);
    expect(slotOf(state, 'w2')).toBe(1);
    expect(slotOf(state, 'w3')).toBe(2);
    expect(slotOf(state, 'w4')).toBe(3);
    expect(slotOf(state, 'w5')).toBeUndefined();
    expect(state.waitQueue).toEqual([{ sessionKey: 'w5', queuedAt: 1000 }]);
  });

  // Adversarial boundary twin: exactly 4 concurrent workers must ALL dock, with no wait line —
  // proves the 5th-worker wait only triggers once every slot is genuinely full.
  it('does NOT queue anyone when exactly 4 workers request concurrently', () => {
    let state = createArchiveDockState();
    for (const worker of ['w1', 'w2', 'w3', 'w4']) {
      state = requestArchiveDock(state, worker, 1000);
    }

    expect(state.waitQueue).toEqual([]);
    expect(state.slots.filter((s) => s.occupiedBySessionKey !== null)).toHaveLength(4);
  });

  it('releasing a slot promotes the front of the wait queue into that exact slot', () => {
    let state = createArchiveDockState();
    for (const worker of ['w1', 'w2', 'w3', 'w4', 'w5']) {
      state = requestArchiveDock(state, worker, 1000);
    }

    state = releaseArchiveDock(state, 'w2'); // frees slot 1

    expect(slotOf(state, 'w2')).toBeUndefined();
    expect(slotOf(state, 'w5')).toBe(1);
    expect(state.waitQueue).toEqual([]);
  });

  it('releasing a worker that was only ever waiting (never docked) drops it from the wait line without touching slots', () => {
    let state = createArchiveDockState();
    for (const worker of ['w1', 'w2', 'w3', 'w4', 'w5']) {
      state = requestArchiveDock(state, worker, 1000);
    }

    state = releaseArchiveDock(state, 'w5');

    expect(state.waitQueue).toEqual([]);
    expect(state.slots.filter((s) => s.occupiedBySessionKey !== null)).toHaveLength(4);
  });

  // Round-robin, not naive first-fit: after slot 0 is assigned and freed again, the NEXT request
  // must advance to slot 1, not reuse slot 0 — even though slot 0 is the lowest free index and a
  // naive "always pick the lowest free slot" implementation would reuse it instead.
  it('cycles the assignment cursor round-robin rather than always refilling the lowest free index', () => {
    let state = requestArchiveDock(createArchiveDockState(), 'w1', 1000);
    expect(slotOf(state, 'w1')).toBe(0);

    state = releaseArchiveDock(state, 'w1'); // slot 0 is free again; every slot is now free

    state = requestArchiveDock(state, 'w2', 2000);

    expect(slotOf(state, 'w2')).toBe(1); // round-robin cursor advanced past slot 0, not naive-lowest
  });
});
