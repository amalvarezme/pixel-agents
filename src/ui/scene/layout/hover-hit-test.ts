/**
 * Pure hit-test + tooltip placement math for the DOM hover-tooltip overlay. No DOM, no PixiJS
 * (dependency-cruiser's `pixi-only-in-scene-pixi` rule forbids importing pixi.js outside
 * `ui/scene/pixi/`) — `character-pose.ts` is safe to import here because it is itself pixi-free.
 *
 * WHY a DOM overlay driven by a pure hit-test at all: `updateStage` (`ui/scene/pixi/
 * pixi-office-renderer.ts`) calls `stage.removeChildren()` and rebuilds the entire PixiJS scene
 * graph on every animation frame (`ui/main.ts` calls `container.tick(now)` inside
 * `requestAnimationFrame`), so any hover state or event listener attached to a PixiJS display
 * object would be destroyed ~60x/second. Hover therefore lives entirely outside the scene graph:
 * `pixi-office-renderer.ts` listens for `pointermove`/`pointerleave` on the `<canvas>` element
 * itself (which is NOT rebuilt every frame) and hit-tests against this module's pure floor-plan
 * math, using the last `OfficeFloorView` it rendered.
 */
import type { DeskView } from '../../components/molecules/desk';
import { buildCharacterPose } from '../character/character-pose';

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

/** Mirrors `ui/scene/pixi/office-scene-renderer.ts`'s own `CHARACTER_DESK_CLEARANCE` (the gap
 * kept between the character's feet and the desk's back edge). Duplicated rather than imported:
 * that file is the one place allowed to import pixi.js, and importing it here — even for a single
 * constant — would drag pixi.js into this pixi-free module's dependency graph. */
const CHARACTER_DESK_CLEARANCE = 6;

/**
 * The character's own topmost drawn edge (a negative scene-unit offset above its origin/feet),
 * derived from the ACTUAL pose data in `character-pose.ts` rather than a guessed magic number.
 * Computed once, for the worst-case reach: `idle` state with `frame` chosen for the upward bob
 * (`idleBob` in `character-pose.ts` lifts the whole figure on odd idle frames), `role:
 * 'orchestrator'` (its supervisor "cape" panel sits behind the torso and never extends above the
 * head, so it never changes this value, but including it keeps this honest about what's drawn).
 */
function computeCharacterTopReach(): number {
  const shapes = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 1, accentColor: 0 });
  return Math.min(...shapes.map((shape) => shape.y - shape.height / 2));
}

const CHARACTER_TOP_REACH = computeCharacterTopReach();

export interface HoverBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The hover box for one desk: the desk slab plus the character standing behind it
 * (`renderWorkerCharacter` in `office-scene-renderer.ts` positions the character's feet at
 * `-(deskHeight / 2 + CHARACTER_DESK_CLEARANCE)` relative to the desk centre, matched here).
 * Horizontally it is just the desk's own width — the character (~50 scene units across at its
 * widest, the orchestrator's cape) never draws wider than even the smallest desk (120 units).
 */
export function workerHoverBox(desk: DeskView): HoverBox {
  const halfHeight = desk.height / 2;
  const characterOriginY = desk.y - halfHeight - CHARACTER_DESK_CLEARANCE;
  const top = characterOriginY + CHARACTER_TOP_REACH;
  const bottom = desk.y + halfHeight;

  return { x: desk.x - desk.width / 2, y: top, width: desk.width, height: bottom - top };
}

function containsPoint(box: HoverBox, point: ScenePoint): boolean {
  return (
    point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
  );
}

/**
 * Topmost/nearest match, or `null`. Overlaps resolve deterministically: later desks in the array
 * win, matching draw order (`office-scene-renderer.ts` draws desks in array order, so a later
 * desk is drawn on top and should win the hit-test the same way).
 */
export function findWorkerAtScenePoint(desks: DeskView[], point: ScenePoint): string | null {
  let match: string | null = null;
  for (const desk of desks) {
    if (containsPoint(workerHoverBox(desk), point)) match = desk.sessionKey;
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
