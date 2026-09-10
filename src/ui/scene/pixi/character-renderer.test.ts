import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { renderCharacter } from './character-renderer';
import type { CharacterShape } from '../character/character-pose';

describe('renderCharacter — turns pure CharacterShape data into PixiJS Graphics', () => {
  it('draws one Graphics child per shape', () => {
    const shapes: CharacterShape[] = [
      { kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: 0x000000 },
      { kind: 'circle', x: 0, y: -10, width: 8, height: 8, color: 0xffffff },
      { kind: 'rect', x: 5, y: 5, width: 4, height: 4, color: 0xff0000 },
    ];

    const group = renderCharacter(shapes);

    expect(group).toBeInstanceOf(Container);
    expect(group.children).toHaveLength(3);
    expect(group.children.every((child) => child instanceof Graphics)).toBe(true);
  });

  // Adversarial twin: an empty shape list must draw nothing, proving the count is read from the
  // input rather than a hardcoded minimum.
  it('draws no children for an empty shape list', () => {
    const group = renderCharacter([]);
    expect(group.children).toHaveLength(0);
  });

  // Triangulate: a different shape count must produce a matching different children count.
  it('draws a different number of children for a different shape count', () => {
    const one = renderCharacter([{ kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: 0x000000 }]);
    const five = renderCharacter([
      { kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: 0x000000 },
      { kind: 'circle', x: 0, y: 0, width: 10, height: 10, color: 0x000000 },
      { kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: 0x000000 },
      { kind: 'circle', x: 0, y: 0, width: 10, height: 10, color: 0x000000 },
      { kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: 0x000000 },
    ]);

    expect(five.children).toHaveLength(5);
    expect(one.children.length).not.toBe(five.children.length);
  });
});
