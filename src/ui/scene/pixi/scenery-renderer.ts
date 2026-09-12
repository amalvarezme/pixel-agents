/**
 * Turns pure `SceneryLayer[]`/`SceneryShape[]` data (`ui/scene/scenery/office-scenery.ts`) into
 * actual PixiJS `Graphics` calls — the ONLY place office scenery becomes a real draw. Kept
 * separate from `office-scenery.ts` itself so the geometry/colour DECISIONS stay canvas-free and
 * unit-testable (dependency-cruiser's `pixi-only-in-scene-pixi` rule forbids importing pixi.js
 * there), mirroring `character-renderer.ts`'s split from `character-pose.ts`.
 */
import { Container, Graphics } from 'pixi.js';
import type { SceneryLayer, SceneryShape } from '../scenery/office-scenery';

/** Batches every rect in `shapes` into ONE `Graphics` — PixiJS v8 allows many `.rect(...).fill(...)`
 * calls per `Graphics`, and one `Graphics` per prop would be a performance problem given how many
 * small tiles/props the office now draws. */
export function renderSceneryShapes(shapes: SceneryShape[]): Graphics {
  const graphics = new Graphics();
  for (const shape of shapes) {
    graphics.rect(shape.x, shape.y, shape.width, shape.height).fill(shape.color);
  }
  return graphics;
}

/** One `Graphics` per layer, in the given back-to-front order, all under one `Container`. */
export function renderSceneryLayers(layers: SceneryLayer[]): Container {
  const group = new Container();
  for (const layer of layers) {
    group.addChild(renderSceneryShapes(layer.shapes));
  }
  return group;
}
