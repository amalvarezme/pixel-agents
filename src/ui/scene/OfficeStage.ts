/**
 * `OfficeStage` — the presentational half of the container/presentational split (tasks.md 10.4,
 * design.md: "Container-presentational"). It receives an immutable `OfficeViewModel` and renders
 * it through an injected `OfficeRenderer`. It owns NO transport concern: no SSE subscription, no
 * reconnect logic, no knowledge of `EventSource` or the wire event shape. `OfficeContainer` owns
 * all of that and hands this class only the already-projected view model.
 *
 * The renderer is injected rather than imported directly so this file stays decoupled from
 * PixiJS at the type level too — in real wiring the renderer is backed by
 * `ui/scene/pixi/office-scene-renderer.ts`, but this class never imports `pixi.js` itself.
 */
import type { OfficeViewModel } from '../state/office-view-model';

export interface OfficeRenderer {
  render(viewModel: OfficeViewModel): void;
}

export class OfficeStage {
  constructor(private readonly renderer: OfficeRenderer) {}

  update(viewModel: OfficeViewModel): void {
    this.renderer.render(viewModel);
  }
}
