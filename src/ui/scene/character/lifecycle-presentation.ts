/**
 * How a reported `SessionLifecycle` changes what the office draws (spec: office-scene-renderer,
 * "Lifecycle-Distinct Worker Presentation").
 *
 * Pure decision, no PixiJS and no positions: it answers only WHETHER a worker belongs at a desk,
 * whether it may be drawn working, and whether it carries a flag. `office-view-model.ts` turns
 * `seated: false` into an actual waiting position, and the pixi renderer turns `indicator` into
 * actual pixels — the same split every other decision in `ui/scene/character/` follows.
 *
 * The `switch` is TOTAL over the closed union with no `default` branch, so adding an eighth
 * lifecycle member is a compile error here rather than a silently mis-drawn worker.
 */
import type { SessionLifecycle } from '../../../domain/events/types';

export type LifecycleIndicator = 'none' | 'blocked' | 'failed';

export interface LifecyclePresentation {
  /** Whether this worker belongs at its workstation at all. */
  seated: boolean;
  /** Whether it may be drawn typing/working; `false` forces the idle posture regardless of activity. */
  canWork: boolean;
  indicator: LifecycleIndicator;
}

/** A worker whose harness reports no lifecycle, and the shape `running` also resolves to. */
const ORDINARY: LifecyclePresentation = { seated: true, canWork: true, indicator: 'none' };

export function resolveLifecyclePresentation(lifecycle: SessionLifecycle | undefined): LifecyclePresentation {
  // Absent means "no claim" (domain/events/types.ts) — never `running`, and never a reason to draw
  // this worker differently from how it was drawn before lifecycle existed.
  if (lifecycle === undefined) return { ...ORDINARY };

  switch (lifecycle) {
    case 'running':
      return { ...ORDINARY };
    // Accepted but not yet started: present in the room, waiting to be given a desk.
    case 'queued':
      return { seated: false, canWork: false, indicator: 'none' };
    // Started, then blocked on an answer someone has to give it. Keeps its desk — it is mid-task —
    // but must never be drawn typing, or a stuck agent looks like a productive one.
    case 'waiting':
      return { seated: true, canWork: false, indicator: 'blocked' };
    // The two ways work ends badly. Flagged so a failure is visible before the worker is removed,
    // rather than vanishing indistinguishably from a success.
    case 'failed':
    case 'timed_out':
      return { seated: true, canWork: false, indicator: 'failed' };
    // Ended, with nothing to report. A cancellation was someone's choice, not a fault.
    case 'completed':
    case 'cancelled':
      return { seated: true, canWork: false, indicator: 'none' };
  }
}
