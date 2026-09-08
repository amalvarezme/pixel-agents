/**
 * Archive path waypoints (tasks.md 21.1, design.md "The Office Scene": "desk -> one corridor
 * waypoint -> archive along a precomputed path ... so paths do not cut through desks").
 *
 * Pure, canvas-free scene-unit math, matching `office-layout.ts`'s contract: no PixiJS, no DOM.
 *
 * Routed as an axis-aligned dogleg through one shared, always-clear floor band (`CORRIDOR_Y`,
 * strictly below every desk lane, root or child) rather than a diagonal shortcut: a diagonal from
 * an arbitrary desk straight at the archive can clip through an unrelated desk sitting between
 * the two points, while a vertical descent into the corridor, a horizontal traverse along it, and
 * a vertical rise into the archive never does, because every desk occupies its own exclusive x
 * column (`office-layout.ts` DESK_SPACING) with generous clearance either side.
 */
import { FLOOR_HEIGHT } from './office-layout';

export interface ScenePoint {
  x: number;
  y: number;
}

export const ARCHIVE_DESTINATION: ScenePoint = { x: 1720, y: 540 };

/** Below the deepest desk lane (root + child offset + desk half-height) with margin to spare. */
const CORRIDOR_Y = FLOOR_HEIGHT - 60;

/** Desk -> corridor -> archive. `origin` is a worker's current desk position in scene units. */
export function computeArchivePath(origin: ScenePoint): ScenePoint[] {
  return [
    origin,
    { x: origin.x, y: CORRIDOR_Y },
    { x: ARCHIVE_DESTINATION.x, y: CORRIDOR_Y },
    ARCHIVE_DESTINATION,
  ];
}
