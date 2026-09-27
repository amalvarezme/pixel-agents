/**
 * Character animation state selection — pure decision, no PixiJS (dependency-cruiser's
 * `pixi-only-in-scene-pixi` rule forbids importing pixi.js outside `ui/scene/pixi/`). Derives
 * ONE of three drawable states from view-model data the scene already computes: the worker's
 * desk-bound `activity` (`domain/office/office.ts`) and whether it is currently mid archive-trip.
 */
import type { WorkerActivity } from '../../../domain/office/office';
import type { SessionLifecycle } from '../../../domain/events/types';
import { resolveLifecyclePresentation } from './lifecycle-presentation';

export type CharacterAnimationState = 'idle' | 'working' | 'walking';

export interface CharacterAnimationInput {
  /** Absent for a hand-built view model that never specified it — degrades to idle, never
   * invented as "working". */
  activity?: WorkerActivity;
  /** True while a worker's archive-trip is actively in transit (walking-out/walking-back), i.e.
   * NOT while dwelling/highlighted at the cabinet — see office-scene-renderer.ts. */
  isWalking: boolean;
  /** The harness's own scheduler report, when it makes one. Absent means no claim, and renders
   * exactly as it did before lifecycle existed. */
  lifecycle?: SessionLifecycle;
}

/**
 * Walking always wins over the desk-bound activity: a worker cannot be shown typing while mid
 * archive-trip transit.
 *
 * A reported lifecycle can VETO the working clip but never grant it: a `queued` or `waiting` worker
 * is drawn idle no matter what `activity` says, because a task blocked on an answer that still looks
 * like it is typing is worse than no signal at all. The reverse is deliberately not true —
 * `lifecycle: 'running'` does not make an idle worker look busy, since only `activity` knows whether
 * this session has actually done anything lately.
 */
export function selectCharacterAnimationState(input: CharacterAnimationInput): CharacterAnimationState {
  if (input.isWalking) return 'walking';
  if (!resolveLifecyclePresentation(input.lifecycle).canWork) return 'idle';
  return input.activity === 'working' ? 'working' : 'idle';
}

/**
 * How recent a `tool_start` has to be for a worker to read as actively using a tool (`typing`)
 * rather than thinking between tools (`work`).
 *
 * Recency of `tool_start` alone, deliberately NOT a `tool_start`/`tool_end` pairing: only the
 * claude-code adapter ever emits `tool_end` at all — codex, opencode and antigravity never do — so
 * pairing would make the two clips a claude-code-only feature instead of a signal every harness can
 * drive.
 *
 * Known limitation: codex's parser excludes the `exec` sandbox family from `tool_start` entirely,
 * so a codex worker doing shell work will under-report and read as thinking more than it actually
 * is.
 */
export const TOOL_ACTIVE_WINDOW_MS = 4000;

/**
 * Whether `lastToolStartAt` (`domain/office/office.ts`) is recent enough to draw the worker at the
 * keys. `undefined` (no tool_start ever recorded) is always `false` — never invented as active. A
 * timestamp in the FUTURE counts as active: harness clocks and the render clock are independent
 * processes, and a small forward skew must not read as "stale".
 */
export function isToolRecentlyStarted(lastToolStartAt: number | undefined, now: number): boolean {
  if (lastToolStartAt === undefined) return false;
  return now - lastToolStartAt < TOOL_ACTIVE_WINDOW_MS;
}
