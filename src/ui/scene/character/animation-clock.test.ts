import { describe, expect, it } from 'vitest';
import { selectAnimationFrame } from './animation-clock';

describe('selectAnimationFrame — pure frame progression over time on a fake clock', () => {
  it('starts at frame 0 at time 0, for every state', () => {
    expect(selectAnimationFrame('idle', 0)).toBe(0);
    expect(selectAnimationFrame('working', 0)).toBe(0);
    expect(selectAnimationFrame('walking', 0)).toBe(0);
  });

  it('advances to a LATER frame once enough time has elapsed', () => {
    const early = selectAnimationFrame('idle', 0);
    const later = selectAnimationFrame('idle', 500);
    expect(later).not.toBe(early);
  });

  // Adversarial twin: strictly BEFORE the frame boundary, the frame must not have advanced yet.
  it('does NOT advance before a full frame duration has elapsed', () => {
    expect(selectAnimationFrame('idle', 499)).toBe(selectAnimationFrame('idle', 0));
  });

  it('cycles back to the same frame after a full animation cycle', () => {
    const start = selectAnimationFrame('idle', 0);
    const afterFullCycle = selectAnimationFrame('idle', 1000); // 2 frames * 500ms
    expect(afterFullCycle).toBe(start);
  });

  // Triangulate with a different state: walking has its own, faster cadence and more frames.
  it('walking advances through more distinct frames than idle within the same time window', () => {
    const idleFrames = new Set([0, 150, 300, 450].map((t) => selectAnimationFrame('idle', t)));
    const walkingFrames = new Set([0, 150, 300, 450].map((t) => selectAnimationFrame('walking', t)));
    expect(walkingFrames.size).toBeGreaterThan(idleFrames.size);
  });

  it('cycles walking back to frame 0 after its own full cycle', () => {
    expect(selectAnimationFrame('walking', 600)).toBe(selectAnimationFrame('walking', 0));
  });

  it('clamps a negative clock value to frame 0, never a negative frame index', () => {
    expect(selectAnimationFrame('idle', -100)).toBe(0);
  });
});
