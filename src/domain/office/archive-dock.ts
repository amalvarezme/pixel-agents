/**
 * Cross-worker archive docking (design.md: "the archive has 4 docking slots assigned round-
 * robin, and a fifth worker waits in an adjacent queue line"). Independent of the per-worker
 * `carry-queue.ts` FIFO: this tracks which of the 4 PHYSICAL cabinet slots each worker currently
 * occupies while it has a document actively held for carrying.
 *
 * Assignment cycles through slots via a cursor rather than always refilling the lowest free
 * index, so repeated release/assign cycles distribute fairly across all 4 slots over time.
 *
 * Pure and framework-free: `now` is an explicit parameter (fake-clock by construction).
 */

export const ARCHIVE_SLOT_COUNT = 4;

export interface ArchiveSlot {
  slotIndex: number;
  occupiedBySessionKey: string | null;
}

export interface ArchiveWaitEntry {
  sessionKey: string;
  queuedAt: number;
}

export interface ArchiveDockState {
  slots: ArchiveSlot[];
  waitQueue: ArchiveWaitEntry[];
  /** Round-robin cursor: index of the next slot to PREFER on the next assignment search. */
  nextSlotCursor: number;
}

export function createArchiveDockState(slotCount = ARCHIVE_SLOT_COUNT): ArchiveDockState {
  return {
    slots: Array.from({ length: slotCount }, (_, slotIndex) => ({ slotIndex, occupiedBySessionKey: null })),
    waitQueue: [],
    nextSlotCursor: 0,
  };
}

function findRoundRobinFreeSlot(state: ArchiveDockState): ArchiveSlot | null {
  const n = state.slots.length;
  for (let offset = 0; offset < n; offset++) {
    const slot = state.slots[(state.nextSlotCursor + offset) % n]!;
    if (slot.occupiedBySessionKey === null) return slot;
  }
  return null;
}

/**
 * Requests a docking slot for `sessionKey`. Assigns the next free slot round-robin; if every
 * slot is occupied, the worker joins the wait line instead (task 20.4: "5 simultaneous
 * memory_write events, 4 dock immediately, 1 queues"). Idempotent: a worker already docked or
 * already waiting is left untouched.
 */
export function requestArchiveDock(state: ArchiveDockState, sessionKey: string, now: number): ArchiveDockState {
  if (state.slots.some((s) => s.occupiedBySessionKey === sessionKey)) return state;
  if (state.waitQueue.some((w) => w.sessionKey === sessionKey)) return state;

  const freeSlot = findRoundRobinFreeSlot(state);
  if (!freeSlot) {
    return { ...state, waitQueue: [...state.waitQueue, { sessionKey, queuedAt: now }] };
  }

  const slots = state.slots.map((s) => (s.slotIndex === freeSlot.slotIndex ? { ...s, occupiedBySessionKey: sessionKey } : s));
  return { ...state, slots, nextSlotCursor: (freeSlot.slotIndex + 1) % state.slots.length };
}

/**
 * Releases `sessionKey`'s dock. If it was occupying a slot, the front of the wait queue (if any)
 * is promoted directly into that exact slot. If it was only ever waiting, it is simply dropped
 * from the wait line.
 */
export function releaseArchiveDock(state: ArchiveDockState, sessionKey: string): ArchiveDockState {
  const slotIndex = state.slots.findIndex((s) => s.occupiedBySessionKey === sessionKey);
  if (slotIndex === -1) {
    return { ...state, waitQueue: state.waitQueue.filter((w) => w.sessionKey !== sessionKey) };
  }

  const [next, ...restWait] = state.waitQueue;
  const slots = state.slots.map((s, i) => (i === slotIndex ? { ...s, occupiedBySessionKey: next?.sessionKey ?? null } : s));
  return { ...state, slots, waitQueue: restWait };
}
