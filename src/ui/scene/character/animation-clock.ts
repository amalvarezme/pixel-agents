/**
 * Frame progression over time — pure arithmetic on the same animation clock `OfficeContainer`
 * already threads through (`ui/scene/animation/trip-animation.ts`'s `now`), mirroring how
 * `interpolatePath` there resolves a walk POSITION at time t. This resolves a walk-cycle/typing/
 * breathing FRAME at time t instead. No PixiJS import.
 */
import type { CharacterAnimationState } from './animation-state';

const FRAME_COUNTS: Record<CharacterAnimationState, number> = { idle: 2, working: 2, walking: 4 };
const FRAME_DURATIONS_MS: Record<CharacterAnimationState, number> = { idle: 500, working: 220, walking: 150 };

/** Frame index for `state` at clock time `now`. Deterministic: the same `now` always yields the
 * same frame, so progression is verifiable with a fake clock and no real timer. */
export function selectAnimationFrame(state: CharacterAnimationState, now: number): number {
  const duration = FRAME_DURATIONS_MS[state];
  const count = FRAME_COUNTS[state];
  return Math.floor(Math.max(0, now) / duration) % count;
}
