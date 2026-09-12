/**
 * The exterior Sentinel's patrol — pure, canvas-free, and a pure FUNCTION OF TIME.
 *
 * What it is: an original science-fiction machine that walks past the office windows, stops to
 * scan, and moves on (`docs/pixel-office/IMPLEMENTACION_AGENTE_CODIGO.md` section 11). It is
 * scenery and nothing else: it represents no session, no agent and no event, and the renderer draws
 * it only through `window_mask.png` so it can never be mistaken for someone in the room. That is
 * deliberate — a monitor must not put a figure on screen that means nothing, without saying so.
 *
 * The pack's own `SentinelController.js` is a mutable state machine advanced by `dt`. This is the
 * same walk/scan cycle expressed as `f(now)` instead, matching how everything else animated in this
 * codebase works (`trip-animation.ts`): the scene rebuilds itself from scratch every frame and
 * holds no animation state of its own, so a controller carrying position between frames would be
 * the only mutable thing in the render path — and untestable without a clock.
 */
import { SENTINEL_PATH, type MapPoint } from './office-map';

/** Pixels per second, from the pack's own controller. */
export const SENTINEL_SPEED = 45;
/** How long it stops to scan on arriving at each waypoint, from the same controller. */
export const SENTINEL_SCAN_MS = 2200;

export type SentinelAction = 'walk' | 'scan';

export interface SentinelState {
  x: number;
  y: number;
  action: SentinelAction;
  /** True while walking right-to-left, so the renderer can mirror the sprite. The pack draws the
   * Sentinel from one side only, so this is the same mirror-rather-than-duplicate rule the
   * characters use. */
  mirrored: boolean;
  /** Milliseconds since this leg of the cycle began — the clip's own clock, so a scan always
   * starts on its first frame rather than wherever the global clock happens to be. */
  elapsedMs: number;
}

interface PatrolLeg {
  from: MapPoint;
  to: MapPoint;
  walkMs: number;
}

/**
 * The patrol as a closed loop: walk to each waypoint in turn, scan there, and from the last one
 * walk all the way back to the first. Built once from the map.
 */
function buildLegs(path: readonly MapPoint[]): PatrolLeg[] {
  return path.map((point, index) => {
    const from = index === 0 ? path[path.length - 1]! : path[index - 1]!;
    return { from, to: point, walkMs: (Math.hypot(point.x - from.x, point.y - from.y) / SENTINEL_SPEED) * 1000 };
  });
}

const LEGS = buildLegs(SENTINEL_PATH);
const CYCLE_MS = LEGS.reduce((total, leg) => total + leg.walkMs + SENTINEL_SCAN_MS, 0);

/**
 * Where the Sentinel is, and what it is doing, at clock reading `now`.
 *
 * Deterministic and loop-safe: the cycle repeats forever, and a `now` from before the clock
 * started resolves to the first frame of the first leg rather than to a negative position.
 */
export function sentinelStateAt(now: number): SentinelState {
  const at = CYCLE_MS > 0 ? ((now % CYCLE_MS) + CYCLE_MS) % CYCLE_MS : 0;

  let remaining = at;
  for (const leg of LEGS) {
    if (remaining < leg.walkMs) {
      const progress = leg.walkMs === 0 ? 1 : remaining / leg.walkMs;
      return {
        x: leg.from.x + (leg.to.x - leg.from.x) * progress,
        y: leg.from.y + (leg.to.y - leg.from.y) * progress,
        action: 'walk',
        mirrored: leg.to.x < leg.from.x,
        elapsedMs: remaining,
      };
    }
    remaining -= leg.walkMs;

    if (remaining < SENTINEL_SCAN_MS) {
      return { x: leg.to.x, y: leg.to.y, action: 'scan', mirrored: false, elapsedMs: remaining };
    }
    remaining -= SENTINEL_SCAN_MS;
  }

  // Unreachable while `at < CYCLE_MS`, but a float `%` can land exactly on the boundary.
  const last = LEGS[LEGS.length - 1]!;
  return { x: last.to.x, y: last.to.y, action: 'scan', mirrored: false, elapsedMs: 0 };
}
