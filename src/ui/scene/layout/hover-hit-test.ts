/**
 * Pure hit-test + tooltip placement math for the DOM hover-tooltip overlay. No DOM, no PixiJS
 * (dependency-cruiser's `pixi-only-in-scene-pixi` rule forbids importing pixi.js outside
 * `ui/scene/pixi/`).
 *
 * WHY a DOM overlay driven by a pure hit-test at all: `updateStage` (`ui/scene/pixi/
 * pixi-office-renderer.ts`) calls `stage.removeChildren()` and rebuilds the entire PixiJS scene
 * graph on every animation frame (`ui/main.ts` calls `container.tick(now)` inside
 * `requestAnimationFrame`), so any hover state or event listener attached to a PixiJS display
 * object would be destroyed ~60x/second. Hover therefore lives entirely outside the scene graph:
 * `pixi-office-renderer.ts` listens for `pointermove`/`pointerleave` on the `<canvas>` element
 * itself (which is NOT rebuilt every frame) and hit-tests against this module's pure math, using
 * the last `OfficeFloorView` it rendered.
 */
import { CHARACTER_BODY_HALF_WIDTH, CHARACTER_BODY_HEIGHT } from '../character/character-sprite';
import type { WorkerView } from '../../components/molecules/worker';

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScenePoint {
  x: number;
  y: number;
}

/** Moved here (out of `pixi-office-renderer.ts`) so this pixi-free module can use it without
 * importing anything from `ui/scene/pixi/` — `pixi-office-renderer.ts` now imports it FROM here
 * instead of declaring its own copy. */
export interface ViewportFit {
  /** Uniform scale applied to the stage so the whole floor plan fits the viewport. */
  scale: number;
  /** Stage offset centring the scaled floor plan inside the viewport (letter/pillarboxing). */
  x: number;
  y: number;
}

/**
 * Inverse of `fitToViewport` (`ui/scene/pixi/pixi-office-renderer.ts`): maps a canvas/CSS-pixel
 * point (e.g. a `pointermove` event's canvas-relative coordinates) back to scene units, so the
 * pure floor-plan hit-test (`findWorkerAtScenePoint`) can run against it.
 */
export function screenToScene(point: ScreenPoint, fit: ViewportFit): ScenePoint {
  // A non-positive scale cannot be inverted (division by zero or a sign-flipping negative scale
  // would place the point nowhere meaningful) — fall back to treating the fit as the identity
  // transform rather than producing NaN/Infinity or a mirrored point.
  if (fit.scale <= 0) return { x: point.x, y: point.y };
  return { x: (point.x - fit.x) / fit.scale, y: (point.y - fit.y) / fit.scale };
}

export interface HoverBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The box around one character, in scene units: its drawn body, sized by the same scale the
 * renderer draws it at (`WorkerView.scale`) and anchored on the same point (its feet).
 *
 * Hovering targets the PERSON, which is now the only thing the scene places — the desks belong to
 * the background artwork and are not owned by any one worker, so a desk-shaped hover box would
 * claim floor that is not this agent's. The body's own measured pixel bounds come from
 * `character-sprite.ts`, so a repacked sheet moves the hit-test with the art.
 */
export function workerHoverBox(worker: Pick<WorkerView, 'x' | 'y' | 'scale'>): HoverBox {
  const halfWidth = CHARACTER_BODY_HALF_WIDTH * worker.scale;
  const height = CHARACTER_BODY_HEIGHT * worker.scale;

  return { x: worker.x - halfWidth, y: worker.y - height, width: halfWidth * 2, height };
}

function containsPoint(box: HoverBox, point: ScenePoint): boolean {
  return (
    point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
  );
}

/**
 * The worker under `point`, or `null`.
 *
 * Overlaps resolve by DEPTH, the same rule the renderer draws by (`office-scene-renderer.ts`
 * y-sorts by foot position): the character standing further forward is drawn in front, so it also
 * wins the hover. Ties keep the later worker, matching array draw order.
 */
export function findWorkerAtScenePoint(
  workers: Pick<WorkerView, 'sessionKey' | 'x' | 'y' | 'scale'>[],
  point: ScenePoint,
): string | null {
  let match: string | null = null;
  let matchY = -Infinity;
  for (const worker of workers) {
    if (!containsPoint(workerHoverBox(worker), point)) continue;
    if (worker.y >= matchY) {
      match = worker.sessionKey;
      matchY = worker.y;
    }
  }
  return match;
}

/** Gap kept between the pointer and the tooltip panel so the panel never sits directly under
 * (and does not obscure) the cursor. */
const POINTER_GAP = 16;

/**
 * Keeps a tooltip panel fully inside the viewport near the pointer: it prefers sitting
 * below-right of the cursor, but flips to the other side of the pointer on whichever axis would
 * otherwise overflow the viewport, and never returns a negative coordinate.
 */
export function computeTooltipPlacement(
  pointer: ScreenPoint,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): ScreenPoint {
  let x = pointer.x + POINTER_GAP;
  let y = pointer.y + POINTER_GAP;

  if (x + panel.width > viewport.width) x = pointer.x - POINTER_GAP - panel.width;
  if (y + panel.height > viewport.height) y = pointer.y - POINTER_GAP - panel.height;

  return { x: Math.max(0, x), y: Math.max(0, y) };
}
