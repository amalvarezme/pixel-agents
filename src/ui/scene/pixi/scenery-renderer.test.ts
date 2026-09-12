import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { renderSceneryLayers, renderSceneryShapes } from './scenery-renderer';
import type { SceneryLayer, SceneryShape } from '../scenery/office-scenery';

describe('renderSceneryShapes — batches every rect into ONE Graphics', () => {
  it('draws a single Graphics for multiple shapes', () => {
    const shapes: SceneryShape[] = [
      { x: 0, y: 0, width: 10, height: 10, color: 0x000000 },
      { x: 10, y: 0, width: 10, height: 10, color: 0xffffff },
      { x: 20, y: 0, width: 10, height: 10, color: 0xff0000 },
    ];

    const graphics = renderSceneryShapes(shapes);

    expect(graphics).toBeInstanceOf(Graphics);
  });

  // Adversarial twin: an empty shape list must still produce a (valid, empty) Graphics, never throw.
  it('handles an empty shape list without throwing', () => {
    expect(() => renderSceneryShapes([])).not.toThrow();
    expect(renderSceneryShapes([])).toBeInstanceOf(Graphics);
  });
});

describe('renderSceneryLayers — one Graphics child per layer', () => {
  it('produces exactly N Graphics children for N layers', () => {
    const layers: SceneryLayer[] = [
      { name: 'wall', shapes: [{ x: 0, y: 0, width: 100, height: 20, color: 0x1a1a22 }] },
      { name: 'floor', shapes: [{ x: 0, y: 20, width: 100, height: 80, color: 0x24242e }] },
      { name: 'archive', shapes: [{ x: 50, y: 50, width: 10, height: 10, color: 0x4a4a5c }] },
    ];

    const group = renderSceneryLayers(layers);

    expect(group).toBeInstanceOf(Container);
    expect(group.children).toHaveLength(3);
    expect(group.children.every((c) => c instanceof Graphics)).toBe(true);
  });

  // Adversarial twin: a different layer count must produce a matching different children count,
  // proving the child count is read from the input rather than a hardcoded minimum.
  it('produces a different children count for a different layer count', () => {
    const one = renderSceneryLayers([{ name: 'wall', shapes: [] }]);
    const four = renderSceneryLayers([
      { name: 'wall', shapes: [] },
      { name: 'windows', shapes: [] },
      { name: 'floor', shapes: [] },
      { name: 'props', shapes: [] },
    ]);

    expect(one.children).toHaveLength(1);
    expect(four.children).toHaveLength(4);
  });

  it('handles an empty layer list, producing an empty Container', () => {
    const group = renderSceneryLayers([]);
    expect(group.children).toHaveLength(0);
  });
});
