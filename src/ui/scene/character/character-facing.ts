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
import type { CharacterDirection } from './character-sprite';

export type CharacterFacing = 'left' | 'right';

/** Minimal shape of a scene-unit point, so this module needs no import from the layout layer. */
export interface ScenePointLike {
  x: number;
  y: number;
}

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

/**
 * The four-way direction of travel between two points, exactly as the pack's own `OfficeAgent.js`
 * derives it: whichever axis the movement is dominated by wins, so a character walking mostly
 * sideways shows the (mirrored) `side` clip and one walking mostly up or down shows its back or
 * its face. v2 characters are drawn in all four directions, so the old left/right-only read is no
 * longer enough on its own — `resolveCharacterFacing` above stays for the procedural fallback
 * figure, which has only the two.
 *
 * A zero delta (the two points coincide) resolves to `down`: facing the viewer is the pack's own
 * `defaultDirection`, and it keeps a character that has arrived from flickering between clips.
 */
export function resolveMoveDirection(from: ScenePointLike, to: ScenePointLike): CharacterDirection {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  if (dy < 0) return 'up';
  return 'down';
}
