import { describe, expect, it } from 'vitest';
import {
  computeTooltipPlacement,
  findWorkerAtScenePoint,
  screenToScene,
  workerHoverBox,
  type ViewportFit,
} from './hover-hit-test';
import { CHARACTER_BODY_HALF_WIDTH, CHARACTER_BODY_HEIGHT } from '../character/character-sprite';

interface HoverWorker {
  sessionKey: string;
  x: number;
  y: number;
  scale: number;
}

/** A worker standing on the floor at `(x, y)` — the feet, exactly as the renderer places it. */
function worker(overrides: Partial<HoverWorker> = {}): HoverWorker {
  return { sessionKey: 'claude-code:s1', x: 760, y: 540, scale: 3, ...overrides };
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

describe('workerHoverBox — the character\'s own drawn body', () => {
  it('is centred on the character and as wide as its drawn body', () => {
    const box = workerHoverBox(worker({ x: 760, scale: 3 }));

    expect(box.x).toBe(760 - CHARACTER_BODY_HALF_WIDTH * 3);
    expect(box.width).toBe(CHARACTER_BODY_HALF_WIDTH * 2 * 3);
  });

  it('stands on the character\'s feet and reaches up to the top of its head', () => {
    // The worker position IS the feet (the pack's `origin`), so the box goes up from there — not
    // down, and not centred on it.
    const box = workerHoverBox(worker({ y: 540, scale: 3 }));

    expect(box.y + box.height).toBe(540);
    expect(box.y).toBe(540 - CHARACTER_BODY_HEIGHT * 3);
  });

  it('grows with the scale the renderer actually draws the character at', () => {
    // Scale carries both the room's perspective and the role bonus, so a big orchestrator at the
    // front of the room must be hoverable over its whole height, not a subagent-sized slice of it.
    const small = workerHoverBox(worker({ scale: 2 }));
    const large = workerHoverBox(worker({ scale: 4 }));

    expect(large.height).toBeGreaterThan(small.height);
    expect(large.width).toBeGreaterThan(small.width);
  });

  it('never reaches below the floor the character stands on', () => {
    // Anything below the feet belongs to whoever is standing in FRONT of this character.
    for (const scale of [2, 3, 4, 5]) {
      const box = workerHoverBox(worker({ y: 600, scale }));
      expect(box.y + box.height).toBeLessThanOrEqual(600);
    }
  });
});

describe('findWorkerAtScenePoint — the character under the pointer, or null', () => {
  const a = worker({ sessionKey: 'a', x: 300, y: 500, scale: 3 });
  const b = worker({ sessionKey: 'b', x: 900, y: 500, scale: 3 });

  it('returns the sessionKey of the character the point is over', () => {
    expect(findWorkerAtScenePoint([a, b], { x: 900, y: 480 })).toBe('b');
  });

  it('hits the body well above the feet, not just the floor position', () => {
    expect(findWorkerAtScenePoint([a, b], { x: 300, y: 500 - CHARACTER_BODY_HEIGHT * 3 + 5 })).toBe('a');
  });

  it('returns null for a point over empty floor', () => {
    expect(findWorkerAtScenePoint([a, b], { x: 600, y: 900 })).toBeNull();
  });

  it('returns null for an empty office', () => {
    expect(findWorkerAtScenePoint([], { x: 300, y: 500 })).toBeNull();
  });

  it('resolves an overlap in favour of the character standing in FRONT', () => {
    // Same rule the renderer draws by (y-sorted): the nearer character is on top, so it is also
    // the one the pointer is really over. Deliberately listed back-to-front to prove the choice is
    // made by depth, not by array order.
    const behind = worker({ sessionKey: 'behind', x: 500, y: 500, scale: 3 });
    const inFront = worker({ sessionKey: 'in-front', x: 505, y: 560, scale: 3 });

    expect(findWorkerAtScenePoint([inFront, behind], { x: 502, y: 495 })).toBe('in-front');
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
