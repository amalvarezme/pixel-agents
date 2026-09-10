import { describe, expect, it } from 'vitest';
import { buildDeskView, ROOT_DESK_SIZE, SINGLE_AGENT_DESK_SIZE } from './desk';

describe('buildDeskView (molecule) — the desk furniture under a worker', () => {
  it('sizes a root-lane desk at the standard width, positioned at the worker coordinates', () => {
    const desk = buildDeskView({ sessionKey: 'claude-code:s1', x: 960, y: 540, lane: 'root' }, { totalWorkerCount: 3 });

    expect(desk.sessionKey).toBe('claude-code:s1');
    expect(desk.x).toBe(960);
    expect(desk.y).toBe(540);
    expect(desk.width).toBe(ROOT_DESK_SIZE);
  });

  it('draws a wider desk for the single-agent layout (design.md: "larger sprite, wider caption strip")', () => {
    const desk = buildDeskView({ sessionKey: 'claude-code:s1', x: 960, y: 540, lane: 'root' }, { totalWorkerCount: 1 });

    expect(desk.width).toBe(SINGLE_AGENT_DESK_SIZE);
    expect(desk.width).toBeGreaterThan(ROOT_DESK_SIZE);
  });

  it('sizes a child-lane desk slightly smaller than a root desk, staying visually distinct', () => {
    const desk = buildDeskView({ sessionKey: 'claude-code:c1', x: 960, y: 760, lane: 'child' }, { totalWorkerCount: 2 });

    expect(desk.width).toBeLessThan(ROOT_DESK_SIZE);
  });

  // Defect fix: `{ width: size, height: size }` drew a SQUARE — the old worker-body rectangle,
  // never shaped like a desk — with the character standing on top of it, reading as "a figure on
  // a giant crate". A desk must be a wide, short surface: width stays in the same ballpark
  // (packed-row spacing depends on it), but height must be materially shorter.
  describe('desk proportions — a wide, short surface, not a square body block', () => {
    it('draws a root-lane desk materially wider than it is tall', () => {
      const desk = buildDeskView({ sessionKey: 'claude-code:s1', x: 960, y: 540, lane: 'root' }, { totalWorkerCount: 3 });

      expect(desk.width).toBe(ROOT_DESK_SIZE);
      expect(desk.height).toBeLessThan(desk.width);
      expect(desk.width / desk.height).toBeGreaterThanOrEqual(3);
    });

    it('draws the single-agent desk materially wider than it is tall too', () => {
      const desk = buildDeskView({ sessionKey: 'claude-code:s1', x: 960, y: 540, lane: 'root' }, { totalWorkerCount: 1 });

      expect(desk.width / desk.height).toBeGreaterThanOrEqual(3);
    });

    // Adversarial twin: the child-lane branch must independently apply the same short-height
    // treatment — proves the fix is not special-cased onto only one branch of `sizeForDesk`.
    it('draws the child-lane desk materially wider than it is tall too', () => {
      const desk = buildDeskView({ sessionKey: 'claude-code:c1', x: 960, y: 760, lane: 'child' }, { totalWorkerCount: 2 });

      expect(desk.width / desk.height).toBeGreaterThanOrEqual(3);
    });
  });
});
