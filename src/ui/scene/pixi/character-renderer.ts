/**
 * Turns pure `CharacterShape[]` data (`ui/scene/character/character-pose.ts`) into actual PixiJS
 * `Graphics` calls — the ONLY place a character's shape data becomes a real draw. Kept separate
 * from `character-pose.ts` itself so the geometry/pose DECISIONS stay canvas-free and unit-
 * testable (dependency-cruiser's `pixi-only-in-scene-pixi` rule forbids importing pixi.js there).
 */
import { Container, Graphics } from 'pixi.js';
import type { CharacterShape } from '../character/character-pose';

export function renderCharacter(shapes: CharacterShape[]): Container {
  const group = new Container();
  for (const shape of shapes) {
    const graphics = new Graphics();
    if (shape.kind === 'circle') {
      graphics.circle(shape.x, shape.y, shape.width / 2).fill(shape.color);
    } else {
      graphics.rect(shape.x - shape.width / 2, shape.y - shape.height / 2, shape.width, shape.height).fill(shape.color);
    }
    group.addChild(graphics);
  }
  return group;
}
