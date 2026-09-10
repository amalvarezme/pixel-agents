import { describe, expect, it } from 'vitest';
import { buildCharacterPose, type CharacterShape } from './character-pose';

const ACCENT_A = 0x111111;
const ACCENT_B = 0x222222;

function headShape(shapes: CharacterShape[]): CharacterShape {
  // The head is the largest circle in the pose (the badge is a smaller circle).
  const circles = shapes.filter((s) => s.kind === 'circle');
  return circles.reduce((biggest, s) => (s.width > biggest.width ? s : biggest));
}

function badgeShape(shapes: CharacterShape[]): CharacterShape {
  const circles = shapes.filter((s) => s.kind === 'circle');
  return circles.reduce((smallest, s) => (s.width < smallest.width ? s : smallest));
}

function legShapes(shapes: CharacterShape[]): CharacterShape[] {
  // Legs are the two rects with the most negative-to-zero y span nearest the ground (y=0).
  return shapes.filter((s) => s.kind === 'rect' && s.x !== 0).slice(0, 2);
}

describe('buildCharacterPose — procedural pixel-art geometry, pure data', () => {
  it('carries the given accent colour onto a small badge shape', () => {
    const shapes = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A });
    expect(badgeShape(shapes).color).toBe(ACCENT_A);
  });

  // Adversarial twin: a different accent colour must produce a different badge colour.
  it('reflects a different accent colour with a different badge colour', () => {
    const withA = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A });
    const withB = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_B });
    expect(badgeShape(withA).color).not.toBe(badgeShape(withB).color);
  });

  describe('orchestrator vs subagent — visibly different output', () => {
    it('draws one extra shape for an orchestrator that a subagent does not get', () => {
      const subagent = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A });
      const orchestrator = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 0, accentColor: ACCENT_A });

      expect(orchestrator.length).toBe(subagent.length + 1);
    });

    // Adversarial twin: the exact same role='subagent' input twice must NOT gain the extra shape.
    it('does not draw the orchestrator-only shape for a subagent', () => {
      const first = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A });
      const second = buildCharacterPose({ role: 'subagent', state: 'working', frame: 0, accentColor: ACCENT_A });

      expect(first.length).toBe(second.length);
    });
  });

  describe('idle — subtle breathing bob', () => {
    it('shifts the head vertically on the second bob frame', () => {
      const frame0 = headShape(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A }));
      const frame1 = headShape(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 1, accentColor: ACCENT_A }));

      expect(frame1.y).not.toBe(frame0.y);
    });

    // Adversarial twin: a NON-idle state must not bob the same way — proves the bob is gated on state.
    it('does not bob while working', () => {
      const frame0 = headShape(buildCharacterPose({ role: 'subagent', state: 'working', frame: 0, accentColor: ACCENT_A }));
      const frame1 = headShape(buildCharacterPose({ role: 'subagent', state: 'working', frame: 1, accentColor: ACCENT_A }));

      expect(frame1.y).toBe(frame0.y);
    });
  });

  describe('working — typing motion', () => {
    it('lifts an arm on frame 0 and the other arm on frame 1', () => {
      const shapes0 = buildCharacterPose({ role: 'subagent', state: 'working', frame: 0, accentColor: ACCENT_A });
      const shapes1 = buildCharacterPose({ role: 'subagent', state: 'working', frame: 1, accentColor: ACCENT_A });

      // Arms are the two rects furthest from the vertical centreline (x=0).
      const arms0 = shapes0.filter((s) => s.kind === 'rect').sort((a, b) => Math.abs(b.x) - Math.abs(a.x)).slice(0, 2);
      const arms1 = shapes1.filter((s) => s.kind === 'rect').sort((a, b) => Math.abs(b.x) - Math.abs(a.x)).slice(0, 2);

      const leftArm0 = arms0.find((s) => s.x < 0)!;
      const leftArm1 = arms1.find((s) => s.x < 0)!;
      expect(leftArm1.y).not.toBe(leftArm0.y);
    });

    // Adversarial twin: idle must not exhibit the same arm-lift transition.
    it('does not lift an arm while idle', () => {
      const shapes0 = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A });
      const shapes1 = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 1, accentColor: ACCENT_A });

      const arm0 = shapes0.filter((s) => s.kind === 'rect').sort((a, b) => Math.abs(b.x) - Math.abs(a.x))[0]!;
      const arm1 = shapes1.filter((s) => s.kind === 'rect').sort((a, b) => Math.abs(b.x) - Math.abs(a.x))[0]!;
      // Both may shift together from the idle bob, but the ARM's position relative to the body
      // (its y minus the head's y) must stay constant — unlike the working typing motion above.
      const head0 = headShape(shapes0);
      const head1 = headShape(shapes1);
      expect(arm1.y - head1.y).toBe(arm0.y - head0.y);
    });
  });

  describe('walking — leg stride', () => {
    it('swings the legs to opposite horizontal offsets across the stride cycle', () => {
      const legsAtPhase0 = legShapes(buildCharacterPose({ role: 'subagent', state: 'walking', frame: 0, accentColor: ACCENT_A }));
      const legsAtPhase2 = legShapes(buildCharacterPose({ role: 'subagent', state: 'walking', frame: 2, accentColor: ACCENT_A }));

      const leftLegAt0 = legsAtPhase0.find((s) => s.x < 0)!;
      const leftLegAt2 = legsAtPhase2.find((s) => s.x < 0)!;
      expect(leftLegAt2.x).not.toBe(leftLegAt0.x);
    });

    // Adversarial twin: legs must NOT swing while idle — the stride offset is gated on walking.
    it('does not swing the legs while idle', () => {
      const legsAtFrame0 = legShapes(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A }));
      const legsAtFrame1 = legShapes(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 1, accentColor: ACCENT_A }));

      const leftLegAt0 = legsAtFrame0.find((s) => s.x < 0)!;
      const leftLegAt1 = legsAtFrame1.find((s) => s.x < 0)!;
      expect(leftLegAt1.x).toBe(leftLegAt0.x);
    });
  });
});
