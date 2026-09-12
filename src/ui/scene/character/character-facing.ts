/**
 * Character facing — pure decision, no PixiJS (dependency-cruiser's `pixi-only-in-scene-pixi` rule
 * forbids importing pixi.js outside `ui/scene/pixi/`). Derives which way a character should face
 * from horizontal movement: given a `from` x and a `to` x, a positive delta (`to` is further right
 * than `from`) faces `'right'`, a negative delta faces `'left'`.
 *
 * Two natural callers: `ui/scene/animation/trip-animation.ts`'s `getTripOverlay` passes an archive
 * trip leg's own endpoints (`walking-out`: desk -> archive; `walking-back`: archive -> desk) to
 * read the trip's own direction of travel; a simpler caller can pass a worker's current x and its
 * desk's x for a "which side of home am I on" read instead.
 */
export type CharacterFacing = 'left' | 'right';

/** Stable default when there is no horizontal delta to read a direction from (equal x, e.g. a
 * character standing exactly at its reference point) — matches `character-pose.ts`'s own
 * unmirrored default, so a stationary worker keeps the same orientation it always had instead of
 * flipping erratically on every render. Deliberately documented, not left to fall out of an
 * `if`/`else` by accident. */
const STABLE_DEFAULT_FACING: CharacterFacing = 'right';

export function resolveCharacterFacing(fromX: number, toX: number): CharacterFacing {
  const delta = toX - fromX;
  if (delta > 0) return 'right';
  if (delta < 0) return 'left';
  return STABLE_DEFAULT_FACING;
}
