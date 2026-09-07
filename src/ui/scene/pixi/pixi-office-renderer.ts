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
 */
import { Application, Container } from 'pixi.js';
import type { OfficeRenderer } from '../OfficeStage';
import type { OfficeViewModel } from '../../state/office-view-model';
import { buildOfficeFloorView } from '../../components/organisms/office-floor';
import { FLOOR_HEIGHT, FLOOR_WIDTH } from '../layout/office-layout';
import { renderOfficeScene } from './office-scene-renderer';

export interface ViewportFit {
  /** Uniform scale applied to the stage so the whole floor plan fits the viewport. */
  scale: number;
  /** Stage offset centring the scaled floor plan inside the viewport (letter/pillarboxing). */
  x: number;
  y: number;
}

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
export function updateStage(stage: StageLike, viewModel: OfficeViewModel): void {
  stage.removeChildren();
  stage.addChild(renderOfficeScene(buildOfficeFloorView(viewModel)));
}

export interface PixiOfficeRendererOptions {
  /** Background fill color for the scene canvas. */
  background?: string;
}

export class PixiOfficeRenderer implements OfficeRenderer {
  private constructor(private readonly app: Application) {}

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

    const renderer = new PixiOfficeRenderer(app);
    renderer.fitStage();
    // `resizeTo` keeps the CANVAS matched to the container, but nothing rescales the fixed floor
    // plan drawn onto it — so re-fit the stage on every resize the renderer reports.
    app.renderer.on('resize', () => renderer.fitStage());

    return renderer;
  }

  /** Rescales and recentres the stage so the whole floor plan fits the current canvas. */
  private fitStage(): void {
    const { scale, x, y } = fitToViewport(this.app.renderer.width, this.app.renderer.height);
    this.app.stage.scale.set(scale);
    this.app.stage.position.set(x, y);
  }

  render(viewModel: OfficeViewModel): void {
    updateStage(this.app.stage, viewModel);
  }
}
