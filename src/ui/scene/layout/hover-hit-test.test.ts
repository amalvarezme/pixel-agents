import { describe, expect, it } from 'vitest';
import {
  computeTooltipPlacement,
  findWorkerAtScenePoint,
  screenToScene,
  workerHoverBox,
  type ViewportFit,
} from './hover-hit-test';
import type { DeskView } from '../../components/molecules/desk';

function desk(overrides: Partial<DeskView> = {}): DeskView {
  return { sessionKey: 'claude-code:s1', x: 760, y: 540, width: 160, height: 40, ...overrides };
}

describe('screenToScene — inverse of fitToViewport (canvas/CSS pixels -> scene units)', () => {
  it('is the identity transform for scale=1 and no letterbox offset', () => {
    expect(screenToScene({ x: 100, y: 200 }, { scale: 1, x: 0, y: 0 })).toEqual({ x: 100, y: 200 });
  });

  it('correctly inverts a non-1 scale AND a non-zero letterbox offset', () => {
    const fit: ViewportFit = { scale: 0.5, x: 20, y: 10 };
    // Round-trip: fitToViewport's own forward transform would be scenePoint*scale + offset.
    const scenePoint = { x: 300, y: 400 };
    const screenPoint = { x: scenePoint.x * fit.scale + fit.x, y: scenePoint.y * fit.scale + fit.y };

    expect(screenToScene(screenPoint, fit)).toEqual(scenePoint);
  });

  // Adversarial twin: a non-zero offset alone (scale=1) must still be subtracted correctly.
  it('inverts a letterbox offset alone when scale is 1', () => {
    expect(screenToScene({ x: 120, y: 60 }, { scale: 1, x: 20, y: 10 })).toEqual({ x: 100, y: 50 });
  });

  it('guards scale <= 0 instead of dividing by zero or a negative number', () => {
    expect(Number.isFinite(screenToScene({ x: 10, y: 10 }, { scale: 0, x: 0, y: 0 }).x)).toBe(true);
    expect(Number.isFinite(screenToScene({ x: 10, y: 10 }, { scale: -1, x: 0, y: 0 }).x)).toBe(true);
  });
});

describe('workerHoverBox — the desk slab plus the character standing behind it', () => {
  it('spans the desk width, centred on the desk x', () => {
    const box = workerHoverBox(desk());

    expect(box.x).toBe(760 - 160 / 2);
    expect(box.width).toBe(160);
  });

  it('reaches its bottom edge at the desk\'s own bottom edge', () => {
    const d = desk();
    const box = workerHoverBox(d);

    expect(box.y + box.height).toBe(d.y + d.height / 2);
  });

  // The decisive requirement: the box must extend UPWARD past the desk's own top edge to cover
  // the character standing behind it, not just the desk slab.
  it('extends upward past the desk\'s own top edge to cover the standing character', () => {
    const d = desk();
    const box = workerHoverBox(d);

    expect(box.y).toBeLessThan(d.y - d.height / 2);
  });

  it('scales its reach with a larger desk (single-agent office)', () => {
    const small = workerHoverBox(desk({ width: 120, height: 30 }));
    const large = workerHoverBox(desk({ width: 240, height: 60 }));

    expect(large.height).toBeGreaterThan(small.height);
  });
});

describe('findWorkerAtScenePoint — topmost/nearest match, or null', () => {
  const deskA = desk({ sessionKey: 'a', x: 400, y: 540 });
  const deskB = desk({ sessionKey: 'b', x: 800, y: 540 });

  it('returns the sessionKey of the desk whose box contains the point', () => {
    expect(findWorkerAtScenePoint([deskA, deskB], { x: 800, y: 540 })).toBe('b');
  });

  it('returns the sessionKey of a desk when the point is over the character reach above it', () => {
    const box = workerHoverBox(deskA);
    const pointNearTop = { x: deskA.x, y: box.y + 1 };

    expect(findWorkerAtScenePoint([deskA, deskB], pointNearTop)).toBe('a');
  });

  it('returns null for a point outside every desk\'s hover box', () => {
    expect(findWorkerAtScenePoint([deskA, deskB], { x: 0, y: 0 })).toBeNull();
  });

  it('returns null for an empty desk list', () => {
    expect(findWorkerAtScenePoint([], { x: 400, y: 540 })).toBeNull();
  });

  // Overlap resolution: later desks in the array win, matching draw order (later drawn = on top).
  it('resolves an overlap by letting the LATER desk in the array win', () => {
    const overlappingA = desk({ sessionKey: 'a', x: 500, y: 540, width: 400 });
    const overlappingB = desk({ sessionKey: 'b', x: 520, y: 540, width: 400 });
    const overlapPoint = { x: 510, y: 540 };

    expect(findWorkerAtScenePoint([overlappingA, overlappingB], overlapPoint)).toBe('b');
    expect(findWorkerAtScenePoint([overlappingB, overlappingA], overlapPoint)).toBe('a');
  });
});

describe('computeTooltipPlacement — keeps the panel fully inside the viewport near the pointer', () => {
  const panel = { width: 200, height: 100 };
  const viewport = { width: 1000, height: 800 };

  it('places the panel near the pointer, offset so it does not sit directly under the cursor', () => {
    const placement = computeTooltipPlacement({ x: 100, y: 100 }, panel, viewport);

    expect(placement.x).toBeGreaterThan(100);
    expect(placement.y).toBeGreaterThan(100);
  });

  it('flips to the LEFT of the pointer instead of overflowing the right edge', () => {
    const placement = computeTooltipPlacement({ x: 950, y: 100 }, panel, viewport);

    expect(placement.x + panel.width).toBeLessThanOrEqual(viewport.width);
    expect(placement.x).toBeLessThan(950);
  });

  it('flips ABOVE the pointer instead of overflowing the bottom edge', () => {
    const placement = computeTooltipPlacement({ x: 100, y: 750 }, panel, viewport);

    expect(placement.y + panel.height).toBeLessThanOrEqual(viewport.height);
    expect(placement.y).toBeLessThan(750);
  });

  it('flips both axes near the bottom-right corner', () => {
    const placement = computeTooltipPlacement({ x: 950, y: 750 }, panel, viewport);

    expect(placement.x + panel.width).toBeLessThanOrEqual(viewport.width);
    expect(placement.y + panel.height).toBeLessThanOrEqual(viewport.height);
  });

  it('never returns a negative coordinate even in a corner smaller than the panel', () => {
    const tinyViewport = { width: 150, height: 80 };
    const placement = computeTooltipPlacement({ x: 5, y: 5 }, panel, tinyViewport);

    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.y).toBeGreaterThanOrEqual(0);
  });

  it('never returns a negative coordinate for a pointer at the very top-left corner', () => {
    const placement = computeTooltipPlacement({ x: 0, y: 0 }, panel, viewport);

    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.y).toBeGreaterThanOrEqual(0);
  });
});
