/**
 * SSE ring buffer (tasks.md 9.2, design.md D2: "Resume without replaying history").
 *
 * Holds the last `capacity` published events. A reconnecting client's `Last-Event-ID` is
 * resolved into either a `replay` plan (the requested id is still inside the ring — reply with
 * everything strictly after it) or a `snapshot` plan (no id given, i.e. first connect, or the
 * id fell outside the ring, i.e. it was evicted). Pure and immutable: every function returns a
 * new `RingBuffer` rather than mutating in place, so it stays trivially testable with no I/O.
 */
import type { AgentEvent } from '../../../domain/events/types';

export const RING_CAPACITY = 2000;

export interface RingBuffer {
  readonly capacity: number;
  readonly events: readonly AgentEvent[];
}

export function createRingBuffer(capacity: number = RING_CAPACITY): RingBuffer {
  return { capacity, events: [] };
}

export function appendToRing(ring: RingBuffer, event: AgentEvent): RingBuffer {
  const events = [...ring.events, event];
  const overflow = events.length - ring.capacity;
  return { capacity: ring.capacity, events: overflow > 0 ? events.slice(overflow) : events };
}

export type ReplayPlan = { status: 'replay'; events: AgentEvent[] } | { status: 'snapshot' };

/**
 * `lastEventId === null` means the client connected with no `Last-Event-ID` header (first
 * connect) — always a snapshot. Otherwise, replay is possible only when the requested id is
 * still resolvable inside the ring (i.e. it is the id of the event immediately before the
 * oldest retained event, or later).
 */
export function planReplay(ring: RingBuffer, lastEventId: number | null): ReplayPlan {
  if (lastEventId === null) return { status: 'snapshot' };

  const oldest = ring.events[0];
  if (!oldest) return { status: 'snapshot' };

  const resumableFloor = oldest.id - 1;
  if (lastEventId < resumableFloor) return { status: 'snapshot' };

  return { status: 'replay', events: ring.events.filter((e) => e.id > lastEventId) };
}
