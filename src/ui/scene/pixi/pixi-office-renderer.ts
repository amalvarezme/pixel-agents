/**
 * Real PixiJS `OfficeRenderer` (browser-entrypoint work unit), completing the container/
 * presentational wiring `OfficeStage` (`ui/scene/OfficeStage.ts`) was built against: it accepts
 * any `OfficeRenderer`, and until now nothing concrete backed it in a real browser.
 *
 * Split in two, deliberately:
 * - `updateStage` is the actual per-frame LOGIC — clear the previous frame, render + attach the
 *   next one from an `OfficeViewModel` (`buildOfficeFloorView` + `renderOfficeScene`, both already
 *   unit-tested). It only needs a `StageLike` (a structural subset of PixiJS's `Container`), so it
 *   is fully unit-testable in Node with a fake stage, without a canvas.
 * - `PixiOfficeRenderer.mount` is the thin, UNTESTABLE-IN-VITEST part: creating a real PixiJS
 *   `Application`, initializing its WebGL/Canvas context, and appending the resulting `<canvas>`
 *   to the DOM, and keeping the fixed floor plan fitted to it. This needs an actual browser; it is
 *   verified manually (see README "Verifying the scene renders"), not by an automated test.
 *
 * Hover tooltip (DOM overlay, not PixiJS interactivity): because `updateStage` rebuilds the
 * ENTIRE scene graph every frame, any `eventMode`/`hitArea`/`on('pointerover')` attached to a
 * PixiJS display object would be destroyed ~60x/second. Hover state instead lives here, driven by
 * `pointermove`/`pointerleave` listeners on the real `<canvas>` element itself (which is NOT
 * rebuilt every frame) — the same untestable-in-vitest bucket as the rest of `mount`. The DECISION
 * logic (whether to fire `onHoverChange`, and what tooltip content to fire it with) is pulled out
 * into the pure, exported `shouldEmitHoverChange`/`resolveHoverTooltip` below, mirroring the
 * `updateStage`/`mount` split above for the same testability reason. The actual hit-test math
 * (`screenToScene`, `findWorkerAtScenePoint`) lives in `ui/scene/layout/hover-hit-test.ts`.
 */
import { Application, Container } from 'pixi.js';
import type { OfficeRenderer } from '../OfficeStage';
import type { OfficeViewModel } from '../../state/office-view-model';
import { buildOfficeFloorView, type OfficeFloorView } from '../../components/organisms/office-floor';
import { FLOOR_HEIGHT, FLOOR_WIDTH } from '../layout/office-layout';
import { renderOfficeBackground, renderOfficeScene, type RenderOfficeSceneOptions } from './office-scene-renderer';
import { CharacterAtlas } from './sprite-character-renderer';
import type { AgentTooltipView } from '../../components/atoms/agent-tooltip';
import { findWorkerAtScenePoint, screenToScene, type ScenePoint, type ScreenPoint, type ViewportFit } from '../layout/hover-hit-test';

export type { ViewportFit } from '../layout/hover-hit-test';

/**
 * Contain-fits the fixed `FLOOR_WIDTH` x `FLOOR_HEIGHT` floor plan into a real viewport.
 *
 * The layout math is deliberately resolution-independent — it emits scene units on a fixed
 * 1920x1080 plan — so SOMETHING has to map those units onto the actual canvas. Without this the
 * scene is drawn 1:1 in CSS pixels and a smaller window silently clips most of the floor.
 * Aspect ratio is preserved (never stretch a floor plan), and the remainder becomes even
 * letterboxing or pillarboxing.
 */
export function fitToViewport(viewportWidth: number, viewportHeight: number): ViewportFit {
  // A container can legitimately measure 0 mid-layout; a zero or negative scale would collapse the
  // whole scene to a point with no way back, so fall back to 1:1 and let the next resize correct it.
  if (viewportWidth <= 0 || viewportHeight <= 0) return { scale: 1, x: 0, y: 0 };

  const scale = Math.min(viewportWidth / FLOOR_WIDTH, viewportHeight / FLOOR_HEIGHT);

  return {
    scale,
    x: (viewportWidth - FLOOR_WIDTH * scale) / 2,
    y: (viewportHeight - FLOOR_HEIGHT * scale) / 2,
  };
}

export interface StageLike {
  removeChildren(): unknown[];
  addChild(child: Container): void;
}

/** Replaces the stage's entire previous frame with a freshly rendered one. Testable core of
 * `PixiOfficeRenderer.render` — see the file header for why it is split out this way. */
export function updateStage(
  stage: StageLike,
  viewModel: OfficeViewModel,
  options: RenderOfficeSceneOptions = {},
): void {
  stage.removeChildren();
  stage.addChild(renderOfficeScene(buildOfficeFloorView(viewModel), viewModel.now ?? 0, options));
}

/**
 * Decides whether a `pointermove`'s hit-test result should fire `onHoverChange`: only when the
 * hovered session actually changes, OR when it is non-null and the pointer moved (every
 * `pointermove` event inherently means the pointer moved, so "non-null" alone is the gate — this
 * is what makes the tooltip follow the cursor while it stays over the SAME worker, without firing
 * on every identical frame while hovering nothing).
 */
export function shouldEmitHoverChange(previousSessionKey: string | null, nextSessionKey: string | null): boolean {
  return nextSessionKey !== previousSessionKey || nextSessionKey !== null;
}

/** Looks up the hovered worker's own tooltip content from the last rendered `OfficeFloorView`.
 * `null` for no hover, or for a `sessionKey` no longer present in the floor (the worker left
 * between the last render and this pointermove). */
export function resolveHoverTooltip(floor: OfficeFloorView, sessionKey: string | null): AgentTooltipView | null {
  if (!sessionKey) return null;
  return floor.workers.find((worker) => worker.sessionKey === sessionKey)?.tooltip ?? null;
}

export interface PixiOfficeRendererOptions {
  /** Background fill color for the scene canvas. */
  background?: string;
  /** Fires on every hover change (see `shouldEmitHoverChange`) with the hovered worker's tooltip
   * content (or `null` once nothing is hovered) and the pointer's canvas-relative position, so the
   * caller (`ui/main.ts`) can position and fill a DOM tooltip overlay outside the canvas. */
  onHoverChange?: (tooltip: AgentTooltipView | null, pointer: ScreenPoint) => void;
}

export class PixiOfficeRenderer implements OfficeRenderer {
  /** The most recently rendered floor plan — needed to hit-test hover against, since PixiJS
   * itself holds no queryable state once `updateStage` has torn the previous frame down. */
  private lastFloorView: OfficeFloorView = { desks: [], workers: [], overflowCount: 0, archiveCount: 0 };
  private lastFit: ViewportFit = { scale: 1, x: 0, y: 0 };
  private lastHoverSessionKey: string | null = null;
  /** The static scenery, built ONCE and re-attached every frame. `stage.removeChildren()` only
   * detaches children, it never destroys them, so the same Container can be re-added forever —
   * turning 560 rect draw-ops per frame into 560 once. See `renderOfficeScene`'s `background`. */
  private readonly background: Container = renderOfficeBackground();
  /** The Pixel Office sprite pack, loaded once in `mount`. Stays `undefined` until that async load
   * resolves, and forever if it fails — the scene draws the procedural figure in the meantime, so
   * the office is never blank while textures are in flight. */
  private atlas?: CharacterAtlas;

  private constructor(
    private readonly app: Application,
    private readonly onHoverChange?: (tooltip: AgentTooltipView | null, pointer: ScreenPoint) => void,
  ) {}

  /** Creates a real PixiJS `Application`, mounts its `<canvas>` into `container`, and returns a
   * renderer wired to it. Needs a real browser DOM; not covered by an automated test. */
  static async mount(container: HTMLElement, options: PixiOfficeRendererOptions = {}): Promise<PixiOfficeRenderer> {
    const app = new Application();
    await app.init({
      resizeTo: container,
      background: options.background ?? '#1e1e28',
      antialias: true,
    });
    container.appendChild(app.canvas);

    const renderer = new PixiOfficeRenderer(app, options.onHoverChange);
    renderer.fitStage();
    // `resizeTo` keeps the CANVAS matched to the container, but nothing rescales the fixed floor
    // plan drawn onto it — so re-fit the stage on every resize the renderer reports.
    app.renderer.on('resize', () => renderer.fitStage());

    // Hover tooltip: real DOM listeners on the canvas (see file header for why NOT PixiJS
    // interactivity). `pointerleave` clears the hover the same way a pointermove landing outside
    // every desk's box would, so leaving the canvas entirely still hides the tooltip.
    if (options.onHoverChange) {
      app.canvas.addEventListener('pointermove', (event: PointerEvent) => {
        const rect = app.canvas.getBoundingClientRect();
        renderer.handlePointerMove({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      });
      app.canvas.addEventListener('pointerleave', () => renderer.handlePointerLeave());
    }

    // Fire-and-forget: the first frames render with the procedural figure and switch to sprites the
    // moment the pack is decoded. Awaiting it here would hold the whole office back on a network
    // round trip for art the app can live without.
    void CharacterAtlas.load().then((atlas) => {
      if (atlas) renderer.atlas = atlas;
    });

    return renderer;
  }

  /** Rescales and recentres the stage so the whole floor plan fits the current canvas. */
  private fitStage(): void {
    this.lastFit = fitToViewport(this.app.renderer.width, this.app.renderer.height);
    this.app.stage.scale.set(this.lastFit.scale);
    this.app.stage.position.set(this.lastFit.x, this.lastFit.y);
  }

  private handlePointerMove(screenPoint: ScreenPoint): void {
    const scenePoint: ScenePoint = screenToScene(screenPoint, this.lastFit);
    const sessionKey = findWorkerAtScenePoint(this.lastFloorView.desks, scenePoint);
    if (!shouldEmitHoverChange(this.lastHoverSessionKey, sessionKey)) return;

    this.lastHoverSessionKey = sessionKey;
    this.onHoverChange?.(resolveHoverTooltip(this.lastFloorView, sessionKey), screenPoint);
  }

  private handlePointerLeave(): void {
    if (this.lastHoverSessionKey === null) return;
    this.lastHoverSessionKey = null;
    this.onHoverChange?.(null, { x: 0, y: 0 });
  }

  render(viewModel: OfficeViewModel): void {
    this.lastFloorView = buildOfficeFloorView(viewModel);
    updateStage(this.app.stage, viewModel, { background: this.background, ...(this.atlas ? { atlas: this.atlas } : {}) });
  }
}
