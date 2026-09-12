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
import { Application, Assets, Container, type Texture } from 'pixi.js';
import type { OfficeRenderer } from '../OfficeStage';
import type { OfficeViewModel } from '../../state/office-view-model';
import { buildOfficeFloorView, type OfficeFloorView } from '../../components/organisms/office-floor';
import { OFFICE_LAYER_URLS, WORLD_HEIGHT, WORLD_WIDTH } from '../world/office-map';
import { renderOfficeBackground, renderOfficeScene, type RenderOfficeSceneOptions } from './office-scene-renderer';
import { CharacterAtlas } from './sprite-character-renderer';
import { SentinelAsset } from './sentinel-renderer';
import type { AgentTooltipView } from '../../components/atoms/agent-tooltip';
import { findWorkerAtScenePoint, screenToScene, type ScenePoint, type ScreenPoint, type ViewportFit } from '../layout/hover-hit-test';

export type { ViewportFit } from '../layout/hover-hit-test';

/**
 * Contain-fits the office's fixed `WORLD_WIDTH` x `WORLD_HEIGHT` room into a real viewport.
 *
 * Every coordinate in the scene is an image pixel of the 1672x941 artwork (`scene/world/
 * office-map.ts`), so SOMETHING has to map those onto the actual canvas. Without this the room is
 * drawn 1:1 in CSS pixels and a smaller window silently clips most of it. Aspect ratio is
 * preserved — never stretch a drawn room — and the remainder becomes even letterboxing or
 * pillarboxing.
 */
export function fitToViewport(viewportWidth: number, viewportHeight: number): ViewportFit {
  // A container can legitimately measure 0 mid-layout; a zero or negative scale would collapse the
  // whole scene to a point with no way back, so fall back to 1:1 and let the next resize correct it.
  if (viewportWidth <= 0 || viewportHeight <= 0) return { scale: 1, x: 0, y: 0 };

  const scale = Math.min(viewportWidth / WORLD_WIDTH, viewportHeight / WORLD_HEIGHT);

  return {
    scale,
    x: (viewportWidth - WORLD_WIDTH * scale) / 2,
    y: (viewportHeight - WORLD_HEIGHT * scale) / 2,
  };
}

/** What the previous frame's discarded children have to offer for this module to release them.
 * Optional because a test's fake stage returns plain objects, and because PixiJS's own
 * `removeChildren` is typed as returning display objects rather than this narrower shape. */
export interface DiscardableChild {
  destroy?: (options?: { children?: boolean }) => void;
}

export interface StageLike {
  removeChildren(): DiscardableChild[];
  addChild(child: Container): void;
}

/**
 * Replaces the stage's entire previous frame with a freshly rendered one. Testable core of
 * `PixiOfficeRenderer.render` — see the file header for why it is split out this way.
 *
 * The previous frame is DESTROYED, not merely detached. `removeChildren` only unparents, and a
 * rebuilt-every-frame scene graph allocates a `Text` per caption — and a PixiJS `Text` owns a
 * canvas-backed texture that nothing but `destroy()` ever frees. At 60fps with a dozen agents that
 * is hundreds of orphaned GPU textures a second.
 *
 * Order matters and is the whole trick: the new scene is built FIRST, which REPARENTS the shared
 * background container (and anything else carried between frames) out of the old scene, so
 * destroying what is left cannot take a still-live object with it. Textures are left alone —
 * `destroy()` frees the display objects, never the atlas or artwork they were drawn from.
 */
export function updateStage(
  stage: StageLike,
  viewModel: OfficeViewModel,
  options: RenderOfficeSceneOptions = {},
): void {
  const previous = stage.removeChildren();
  stage.addChild(renderOfficeScene(buildOfficeFloorView(viewModel), viewModel.now ?? 0, options));
  for (const child of previous) child.destroy?.({ children: true });
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
  private lastFloorView: OfficeFloorView = { workers: [], overflowCount: 0, archiveCount: 0 };
  private lastFit: ViewportFit = { scale: 1, x: 0, y: 0 };
  private lastHoverSessionKey: string | null = null;
  /** The room's back layer, built ONCE and re-attached every frame. `stage.removeChildren()` only
   * detaches children, it never destroys them, so the same Container can be re-added forever.
   * Starts as the flat fallback floor and is replaced the moment `background.png` decodes. */
  private background: Container = renderOfficeBackground();
  /** The room's front layer — desk fronts, plants, the sofa — drawn OVER the agents so they can
   * be occluded by the furniture they stand behind (guide section 4). Undefined until it loads. */
  private foreground?: Texture;
  /** The exterior Sentinel and the window mask that confines it to the glass. Both must be present
   * before either is used: drawing the Sentinel unmasked would walk it through the office. */
  private sentinel?: SentinelAsset;
  private windowMask?: Texture;
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

    // Fire-and-forget, all of it: the first frames render on a flat floor with the procedural
    // figure and swap to the real artwork the moment each file decodes. Awaiting any of it here
    // would hold the whole office back on a round trip for art the app can live without — and a
    // file that never arrives leaves a working, plainer office rather than a blank page.
    void CharacterAtlas.load().then((atlas) => {
      if (atlas) renderer.atlas = atlas;
    });
    void Assets.load<Texture>(OFFICE_LAYER_URLS.background)
      .then((texture) => {
        renderer.background = renderOfficeBackground(texture);
      })
      .catch(() => {});
    void Assets.load<Texture>(OFFICE_LAYER_URLS.foreground)
      .then((texture) => {
        renderer.foreground = texture;
      })
      .catch(() => {});
    void Assets.load<Texture>(OFFICE_LAYER_URLS.windowMask)
      .then((texture) => {
        renderer.windowMask = texture;
      })
      .catch(() => {});
    void SentinelAsset.load().then((asset) => {
      if (asset) renderer.sentinel = asset;
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
    const sessionKey = findWorkerAtScenePoint(this.lastFloorView.workers, scenePoint);
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
    updateStage(this.app.stage, viewModel, {
      background: this.background,
      ...(this.foreground ? { foreground: this.foreground } : {}),
      ...(this.atlas ? { atlas: this.atlas } : {}),
      ...(this.sentinel && this.windowMask
        ? { sentinel: { asset: this.sentinel, windowMask: this.windowMask } }
        : {}),
    });
  }
}
