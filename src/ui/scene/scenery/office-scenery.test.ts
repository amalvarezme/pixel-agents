import { describe, expect, it } from 'vitest';
import { buildDeskProps, buildOfficeScenery, isFloorTilingShape, TILE, type SceneryLayer, type SceneryShape } from './office-scenery';
import { FLOOR_HEIGHT, FLOOR_WIDTH } from '../layout/office-layout';
import { ARCHIVE_DESTINATION } from '../layout/archive-path';

/** Generous keep-out band around each desk lane, independent of the implementation's own margins
 * — matches the task's own description ("root desk lane at y = 540; child lane at y = 760 ...
 * the packed desk row ... roughly x in [0, 1600]"). */
const DESK_ROW_X_MAX = 1600;
const ROOT_LANE_BAND = { yMin: 340, yMax: 660 }; // root lane y=540 +/- 220 headroom for character+caption
const CHILD_LANE_BAND = { yMin: 560, yMax: 880 }; // child lane y=760 +/- 200 headroom
const DESK_LANE_Y_MIN = Math.min(ROOT_LANE_BAND.yMin, CHILD_LANE_BAND.yMin);
const DESK_LANE_Y_MAX = Math.max(ROOT_LANE_BAND.yMax, CHILD_LANE_BAND.yMax);

function rectsOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function isInBounds(shape: SceneryShape): boolean {
  return shape.x >= 0 && shape.y >= 0 && shape.x + shape.width <= FLOOR_WIDTH && shape.y + shape.height <= FLOOR_HEIGHT;
}

function layer(layers: SceneryLayer[], name: string): SceneryLayer {
  const found = layers.find((l) => l.name === name);
  if (!found) throw new Error(`missing layer: ${name}`);
  return found;
}

describe('buildOfficeScenery (tiny pixel-art office, no pixi import) — pure geometry', () => {
  it('is canvas-free: no PixiJS import anywhere in this module', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./office-scenery.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/pixi\.js/);
  });

  it('is built on the TILE grid, exactly 48x27 tiles for the fixed 1920x1080 plan', () => {
    expect(FLOOR_WIDTH % TILE).toBe(0);
    expect(FLOOR_HEIGHT % TILE).toBe(0);
    expect(FLOOR_WIDTH / TILE).toBe(48);
    expect(FLOOR_HEIGHT / TILE).toBe(27);
  });

  it('produces layers in back-to-front order: wall, windows, floor, props, archive', () => {
    const layers = buildOfficeScenery();
    expect(layers.map((l) => l.name)).toEqual(['wall', 'windows', 'floor', 'props', 'archive']);
  });

  it('gives every layer at least one shape', () => {
    const layers = buildOfficeScenery();
    for (const l of layers) {
      expect(l.shapes.length).toBeGreaterThan(0);
    }
  });

  it('keeps every shape, in every layer, inside the 1920x1080 floor bounds', () => {
    const layers = buildOfficeScenery();
    for (const l of layers) {
      for (const shape of l.shapes) {
        expect(isInBounds(shape)).toBe(true);
      }
    }
  });

  it('is deterministic: two calls produce a deep-equal result', () => {
    expect(buildOfficeScenery()).toEqual(buildOfficeScenery());
  });

  // Adversarial twin: determinism must hold across many repeated calls, not just two.
  it('produces the identical shape count across repeated calls', () => {
    const counts = Array.from({ length: 5 }, () => buildOfficeScenery().reduce((sum, l) => sum + l.shapes.length, 0));
    expect(new Set(counts).size).toBe(1);
  });

  describe('archive layer', () => {
    it('centres its overall bounding box on ARCHIVE_DESTINATION', () => {
      const shapes = layer(buildOfficeScenery(), 'archive').shapes;
      const minX = Math.min(...shapes.map((s) => s.x));
      const maxX = Math.max(...shapes.map((s) => s.x + s.width));
      const minY = Math.min(...shapes.map((s) => s.y));
      const maxY = Math.max(...shapes.map((s) => s.y + s.height));

      expect((minX + maxX) / 2).toBe(ARCHIVE_DESTINATION.x);
      expect((minY + maxY) / 2).toBe(ARCHIVE_DESTINATION.y);
    });

    it('draws a filing cabinet as a body plus several drawer/handle/trim details, not one flat square', () => {
      const shapes = layer(buildOfficeScenery(), 'archive').shapes;
      // Old behaviour was exactly one flat 100x100 square; the new cabinet must be composed of
      // several distinct shapes (body + top/base trim + 3 drawer fronts + 3 handles = 9).
      expect(shapes.length).toBeGreaterThanOrEqual(9);
    });

    it('stays a comparable footprint to the old 100-unit square (roughly 80-160 units wide/tall)', () => {
      const shapes = layer(buildOfficeScenery(), 'archive').shapes;
      const minX = Math.min(...shapes.map((s) => s.x));
      const maxX = Math.max(...shapes.map((s) => s.x + s.width));
      const minY = Math.min(...shapes.map((s) => s.y));
      const maxY = Math.max(...shapes.map((s) => s.y + s.height));

      expect(maxX - minX).toBeGreaterThanOrEqual(80);
      expect(maxX - minX).toBeLessThanOrEqual(160);
      expect(maxY - minY).toBeGreaterThanOrEqual(80);
      expect(maxY - minY).toBeLessThanOrEqual(160);
    });
  });

  describe('windows layer', () => {
    it('cuts at least two windows into the wall, plus a clock and a whiteboard panel', () => {
      const shapes = layer(buildOfficeScenery(), 'windows').shapes;
      // 3 windows * 4 shapes (sky/sill/2 mullions) + clock (3) + whiteboard (4) = 19.
      expect(shapes.length).toBeGreaterThanOrEqual(2 * 4 + 3 + 1);
    });

    it('keeps every window/clock/whiteboard shape within the wall band, above the floor', () => {
      const shapes = layer(buildOfficeScenery(), 'windows').shapes;
      for (const shape of shapes) {
        expect(shape.y + shape.height).toBeLessThanOrEqual(220);
      }
    });
  });

  describe('floor layer', () => {
    it('fills the entire area below the wall with the tiled floor', () => {
      const shapes = layer(buildOfficeScenery(), 'floor').shapes;
      const baseFill = shapes.find((s) => s.width === FLOOR_WIDTH);
      expect(baseFill).toBeDefined();
      expect(baseFill!.y).toBe(220);
      expect(baseFill!.y + baseFill!.height).toBe(FLOOR_HEIGHT);
    });

    it('uses a low-contrast checkerboard delta so the floor stays background, not a loud pattern', () => {
      const shapes = layer(buildOfficeScenery(), 'floor').shapes;
      const tiles = shapes.filter((s) => s.width === TILE && s.height === TILE);
      expect(tiles.length).toBeGreaterThan(0);

      const baseFill = shapes.find((s) => s.width === FLOOR_WIDTH)!;
      const toRgb = (color: number): [number, number, number] => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
      const [br, bg, bb] = toRgb(baseFill.color);
      const [tr, tg, tb] = toRgb(tiles[0]!.color);
      const delta = Math.abs(br - tr) + Math.abs(bg - tg) + Math.abs(bb - tb);
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThan(40); // low-contrast: never "out-shout" the characters
    });

    // Adversarial twin: the checkerboard tiling itself necessarily spans the whole floor
    // (including under the desks) — only a genuinely placed prop like the rug must avoid the
    // desk lanes, which is asserted separately below.
    it('has at least one non-tiling shape (the rug) that is not part of the base checkerboard', () => {
      const shapes = layer(buildOfficeScenery(), 'floor').shapes;
      const nonTiling = shapes.filter((s) => !isFloorTilingShape(s));
      expect(nonTiling.length).toBeGreaterThan(0);
    });
  });

  describe('props stay clear of the desk lanes', () => {
    const deskLaneBand = { x: 0, y: DESK_LANE_Y_MIN, width: DESK_ROW_X_MAX, height: DESK_LANE_Y_MAX - DESK_LANE_Y_MIN };

    it('keeps every props-layer shape clear of the root and child desk lane band', () => {
      const shapes = layer(buildOfficeScenery(), 'props').shapes;
      for (const shape of shapes) {
        expect(rectsOverlap(shape, deskLaneBand)).toBe(false);
      }
    });

    it('keeps every non-tiling floor-layer shape (the rug) clear of the desk lane band', () => {
      const shapes = layer(buildOfficeScenery(), 'floor').shapes.filter((s) => !isFloorTilingShape(s));
      expect(shapes.length).toBeGreaterThan(0);
      for (const shape of shapes) {
        expect(rectsOverlap(shape, deskLaneBand)).toBe(false);
      }
    });

    // Adversarial twin: prove the band actually matters — a shape deliberately placed inside it
    // (a stand-in for a prop bug) DOES register as overlapping, so the assertions above are not
    // vacuously true.
    it('the overlap check itself correctly flags a shape placed inside the desk lane band', () => {
      const intruder: SceneryShape = { x: 700, y: 540, width: 40, height: 40, color: 0x000000 };
      expect(rectsOverlap(intruder, deskLaneBand)).toBe(true);
    });
  });
});

describe('buildDeskProps (monitor, keyboard, mouse, mug) — pure geometry', () => {
  it('draws a monitor (stand + bezel + screen), keyboard, mouse, and mug — at least 7 shapes', () => {
    const shapes = buildDeskProps({ width: 160, height: 160 });
    expect(shapes.length).toBeGreaterThanOrEqual(7);
  });

  it('is deterministic for the same desk size', () => {
    expect(buildDeskProps({ width: 160, height: 160 })).toEqual(buildDeskProps({ width: 160, height: 160 }));
  });

  it('draws a screen colour distinct from the bezel colour (a "lit" screen)', () => {
    const shapes = buildDeskProps({ width: 160, height: 160 });
    const colors = new Set(shapes.map((s) => s.color));
    expect(colors.size).toBeGreaterThan(1);
  });

  describe('stays within the desk footprint', () => {
    function assertWithinFootprint(desk: { width: number; height: number }): void {
      const shapes = buildDeskProps(desk);
      for (const shape of shapes) {
        // Horizontally: every prop stays within the desk's own width.
        expect(shape.x).toBeGreaterThanOrEqual(-desk.width / 2);
        expect(shape.x + shape.width).toBeLessThanOrEqual(desk.width / 2);
        // Vertically: nothing sticks out past the desk's own front edge (the monitor is allowed
        // to rise above the desk's back edge, same convention the character already uses).
        expect(shape.y + shape.height).toBeLessThanOrEqual(desk.height / 2);
      }
    }

    it('for a square 160x160 desk (the current default)', () => {
      assertWithinFootprint({ width: 160, height: 160 });
    });

    it('for a short, wide desk', () => {
      assertWithinFootprint({ width: 160, height: 40 });
    });

    // Adversarial twin: a much wider desk must still keep every prop inside ITS OWN width, not
    // the previous desk's width — proves the bound is computed from the input, not hardcoded.
    it('for a much wider desk', () => {
      assertWithinFootprint({ width: 320, height: 80 });
    });
  });

  describe('scales with desk size', () => {
    // The widest single prop shape scales off desk.width for every desk here (currently the
    // keyboard, which is wider than the monitor bezel) — used as a simple proxy for "props got
    // horizontally bigger", without pinning the test to which specific prop happens to be widest.
    const widestShapeWidth = (shapes: SceneryShape[]) => Math.max(...shapes.map((s) => s.width));

    it('draws wider props for a wider desk', () => {
      const narrow = buildDeskProps({ width: 120, height: 120 });
      const wide = buildDeskProps({ width: 320, height: 120 });

      expect(widestShapeWidth(wide)).toBeGreaterThan(widestShapeWidth(narrow));
    });

    // Adversarial twin: the SAME width with a different height must not change the horizontal
    // scaling, proving width and height drive independent axes rather than one blended factor.
    it('keeps the same prop widths when only the height changes', () => {
      const shortDesk = buildDeskProps({ width: 200, height: 60 });
      const tallDesk = buildDeskProps({ width: 200, height: 160 });

      expect(widestShapeWidth(shortDesk)).toBe(widestShapeWidth(tallDesk));
    });
  });
});
