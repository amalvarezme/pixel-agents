import { describe, expect, it } from 'vitest';
import { buildCharacterPose, type CharacterShape } from './character-pose';

const ACCENT_A = 0x111111;
const ACCENT_B = 0x222222;
const BODY_A = 0x5da9e9;
const BODY_B = 0xe07a5f;

function headShape(shapes: CharacterShape[]): CharacterShape {
  // The head is the largest circle in the pose (the badge is a smaller circle).
  const circles = shapes.filter((s) => s.kind === 'circle');
  return circles.reduce((biggest, s) => (s.width > biggest.width ? s : biggest));
}

function badgeShape(shapes: CharacterShape[]): CharacterShape {
  const circles = shapes.filter((s) => s.kind === 'circle');
  return circles.reduce((smallest, s) => (s.width < smallest.width ? s : smallest));
}

/** Non-centreline (x !== 0) rects, in draw order: legs are pushed before arms, so the first two
 * are always the legs and the next two are always the arms — regardless of role (the orchestrator
 * cape sits at x=0 and is excluded here either way). */
function nonZeroXRects(shapes: CharacterShape[]): CharacterShape[] {
  return shapes.filter((s) => s.kind === 'rect' && s.x !== 0);
}

function legShapes(shapes: CharacterShape[]): CharacterShape[] {
  return nonZeroXRects(shapes).slice(0, 2);
}

function armShapes(shapes: CharacterShape[]): CharacterShape[] {
  return nonZeroXRects(shapes).slice(2, 4);
}

/** The torso: the widest rect for a subagent. For an orchestrator the cape (x=0) is wider still,
 * so callers exercising the orchestrator select the torso separately (see the colour-sharing
 * test below). */
function torsoShape(shapes: CharacterShape[]): CharacterShape {
  const rects = shapes.filter((s) => s.kind === 'rect');
  return rects.reduce((widest, s) => (s.width > widest.width ? s : widest));
}

function boundingBox(shapes: CharacterShape[]): { width: number; height: number } {
  const minX = Math.min(...shapes.map((s) => s.x - s.width / 2));
  const maxX = Math.max(...shapes.map((s) => s.x + s.width / 2));
  const minY = Math.min(...shapes.map((s) => s.y - s.height / 2));
  const maxY = Math.max(...shapes.map((s) => s.y + s.height / 2));
  return { width: maxX - minX, height: maxY - minY };
}

describe('buildCharacterPose — procedural pixel-art geometry, pure data', () => {
  it('carries the given accent colour onto a small badge shape', () => {
    const shapes = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
    expect(badgeShape(shapes).color).toBe(ACCENT_A);
  });

  // Adversarial twin: a different accent colour must produce a different badge colour.
  it('reflects a different accent colour with a different badge colour', () => {
    const withA = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
    const withB = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_B, bodyColor: BODY_A });
    expect(badgeShape(withA).color).not.toBe(badgeShape(withB).color);
  });

  describe('orchestrator vs subagent — visibly different output', () => {
    it('draws one extra shape for an orchestrator that a subagent does not get', () => {
      const subagent = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const orchestrator = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });

      expect(orchestrator.length).toBe(subagent.length + 1);
    });

    // Adversarial twin: the exact same role='subagent' input twice must NOT gain the extra shape.
    it('does not draw the orchestrator-only shape for a subagent', () => {
      const first = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const second = buildCharacterPose({ role: 'subagent', state: 'working', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });

      expect(first.length).toBe(second.length);
    });
  });

  describe('idle — subtle breathing bob', () => {
    it('shifts the head vertically on the second bob frame', () => {
      const frame0 = headShape(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A }));
      const frame1 = headShape(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 1, accentColor: ACCENT_A, bodyColor: BODY_A }));

      expect(frame1.y).not.toBe(frame0.y);
    });

    // Adversarial twin: a NON-idle state must not bob the same way — proves the bob is gated on state.
    it('does not bob while working', () => {
      const frame0 = headShape(buildCharacterPose({ role: 'subagent', state: 'working', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A }));
      const frame1 = headShape(buildCharacterPose({ role: 'subagent', state: 'working', frame: 1, accentColor: ACCENT_A, bodyColor: BODY_A }));

      expect(frame1.y).toBe(frame0.y);
    });
  });

  describe('working — typing motion', () => {
    it('lifts an arm on frame 0 and the other arm on frame 1', () => {
      const shapes0 = buildCharacterPose({ role: 'subagent', state: 'working', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const shapes1 = buildCharacterPose({ role: 'subagent', state: 'working', frame: 1, accentColor: ACCENT_A, bodyColor: BODY_A });

      // Arms are the two rects furthest from the vertical centreline (x=0).
      const arms0 = shapes0.filter((s) => s.kind === 'rect').sort((a, b) => Math.abs(b.x) - Math.abs(a.x)).slice(0, 2);
      const arms1 = shapes1.filter((s) => s.kind === 'rect').sort((a, b) => Math.abs(b.x) - Math.abs(a.x)).slice(0, 2);

      const leftArm0 = arms0.find((s) => s.x < 0)!;
      const leftArm1 = arms1.find((s) => s.x < 0)!;
      expect(leftArm1.y).not.toBe(leftArm0.y);
    });

    // Adversarial twin: idle must not exhibit the same arm-lift transition.
    it('does not lift an arm while idle', () => {
      const shapes0 = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const shapes1 = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 1, accentColor: ACCENT_A, bodyColor: BODY_A });

      const arm0 = shapes0.filter((s) => s.kind === 'rect').sort((a, b) => Math.abs(b.x) - Math.abs(a.x))[0]!;
      const arm1 = shapes1.filter((s) => s.kind === 'rect').sort((a, b) => Math.abs(b.x) - Math.abs(a.x))[0]!;
      // Both may shift together from the idle bob, but the ARM's position relative to the body
      // (its y minus the head's y) must stay constant — unlike the working typing motion above.
      const head0 = headShape(shapes0);
      const head1 = headShape(shapes1);
      // toBeCloseTo, not toBe: the role scale factor (0.85 for a subagent) is not a power of two,
      // so floating-point arithmetic taking a different path (idle's zero bob vs working's zero
      // arm-lift) can differ by a sub-nanoscopic epsilon despite being mathematically identical.
      expect(arm1.y - head1.y).toBeCloseTo(arm0.y - head0.y, 9);
    });
  });

  describe('walking — leg stride', () => {
    it('swings the legs to opposite horizontal offsets across the stride cycle', () => {
      const legsAtPhase0 = legShapes(buildCharacterPose({ role: 'subagent', state: 'walking', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A }));
      const legsAtPhase2 = legShapes(buildCharacterPose({ role: 'subagent', state: 'walking', frame: 2, accentColor: ACCENT_A, bodyColor: BODY_A }));

      const leftLegAt0 = legsAtPhase0.find((s) => s.x < 0)!;
      const leftLegAt2 = legsAtPhase2.find((s) => s.x < 0)!;
      expect(leftLegAt2.x).not.toBe(leftLegAt0.x);
    });

    // Adversarial twin: legs must NOT swing while idle — the stride offset is gated on walking.
    it('does not swing the legs while idle', () => {
      const legsAtFrame0 = legShapes(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A }));
      const legsAtFrame1 = legShapes(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 1, accentColor: ACCENT_A, bodyColor: BODY_A }));

      const leftLegAt0 = legsAtFrame0.find((s) => s.x < 0)!;
      const leftLegAt1 = legsAtFrame1.find((s) => s.x < 0)!;
      expect(leftLegAt1.x).toBe(leftLegAt0.x);
    });
  });

  describe('walking — arms counter-swing against the legs', () => {
    it('swings the arm in the opposite sense to the leg on the same side, across the stride cycle', () => {
      const phase0 = buildCharacterPose({ role: 'subagent', state: 'walking', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const phase2 = buildCharacterPose({ role: 'subagent', state: 'walking', frame: 2, accentColor: ACCENT_A, bodyColor: BODY_A });

      const [leftLeg0] = legShapes(phase0);
      const [leftLeg2] = legShapes(phase2);
      const [leftArm0] = armShapes(phase0);
      const [leftArm2] = armShapes(phase2);

      expect(leftLeg0!.x).not.toBe(leftLeg2!.x);
      expect(leftArm0!.y).not.toBe(leftArm2!.y);
      // Counter-swing: the leg moves on x, the arm moves on y, but they flip in OPPOSITE sign
      // together across the same two phases — proves the arm motion is tied to (and opposes) the
      // leg motion, not an independent, unrelated wobble.
      expect(Math.sign(leftLeg0!.x - leftLeg2!.x)).toBe(-Math.sign(leftArm0!.y - leftArm2!.y));
    });

    // Adversarial twin: an idle character has no stride at all — neither legs nor arms.
    it('does not swing arms while idle', () => {
      const frame0 = armShapes(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A }));
      const frame2 = armShapes(buildCharacterPose({ role: 'subagent', state: 'idle', frame: 2, accentColor: ACCENT_A, bodyColor: BODY_A }));

      // Frames 0 and 2 are both even, so the idle bob (odd frames only) does not interfere either.
      expect(frame0[0]!.y).toBe(frame2[0]!.y);
    });

    // Adversarial twin: a working (typing) character swings its arms via the typing lift, not the
    // walking counter-swing — and its LEGS must never stride.
    it('does not stride the legs while working', () => {
      const frame0 = legShapes(buildCharacterPose({ role: 'subagent', state: 'working', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A }));
      const frame1 = legShapes(buildCharacterPose({ role: 'subagent', state: 'working', frame: 1, accentColor: ACCENT_A, bodyColor: BODY_A }));

      expect(frame0[0]!.x).toBe(frame1[0]!.x);
    });
  });

  describe('size — role scales the whole figure', () => {
    // The decisive requirement: SIZE encodes role, not shape/creature — assert the relationship,
    // never a magic pixel number.
    it('draws an orchestrator measurably taller and wider than a subagent, same state/frame/colours', () => {
      const subagent = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const orchestrator = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });

      const subBox = boundingBox(subagent);
      const orchestratorBox = boundingBox(orchestrator);

      expect(orchestratorBox.height).toBeGreaterThan(subBox.height);
      expect(orchestratorBox.width).toBeGreaterThan(subBox.width);
    });

    // Adversarial twin: the SAME role twice (idle vs working) must draw the SAME size — proves
    // size is keyed on role, not incidentally drifting with animation state.
    it('keeps the same size for the same role across different animation states', () => {
      const idle = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const working = buildCharacterPose({ role: 'subagent', state: 'working', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });

      expect(boundingBox(idle).width).toBe(boundingBox(working).width);
    });

    it('keeps the character origin at the feet (ground level) regardless of role scale', () => {
      const subagent = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const orchestrator = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });

      const feetY = (shapes: CharacterShape[]) => Math.max(...legShapes(shapes).map((s) => s.y + s.height / 2));
      // Frame 0 has no idle bob, so both roles' feet sit exactly on the origin (y=0).
      expect(feetY(subagent)).toBe(0);
      expect(feetY(orchestrator)).toBe(0);
    });
  });

  describe('project colour — the whole figure reads as one coloured character', () => {
    it('paints the torso with the given bodyColor', () => {
      const shapes = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      expect(torsoShape(shapes).color).toBe(BODY_A);
    });

    it('derives a darker, consistent limb tone from the bodyColor for both legs and both arms', () => {
      const shapes = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const [leg1, leg2] = legShapes(shapes);
      const [arm1, arm2] = armShapes(shapes);

      expect(leg1!.color).toBe(leg2!.color);
      expect(arm1!.color).toBe(arm2!.color);
      expect(leg1!.color).toBe(arm1!.color);
      expect(leg1!.color).not.toBe(BODY_A); // a darker shade, not identical to the body colour
    });

    // Adversarial twin: a different bodyColor must produce a different torso AND limb colour.
    it('reflects a different bodyColor with different torso and limb colours', () => {
      const withA = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const withB = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_B });

      expect(torsoShape(withA).color).not.toBe(torsoShape(withB).color);
      expect(legShapes(withA)[0]!.color).not.toBe(legShapes(withB)[0]!.color);
    });

    // The cape is a ROLE marker (orchestrator vs subagent), never a project marker — it must stay
    // the fixed harness accent regardless of which project's colour the figure carries.
    it('keeps the orchestrator cape colour independent of the project bodyColor', () => {
      const withA = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const withB = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_B });

      const capeShape = (shapes: CharacterShape[]) =>
        shapes.filter((s) => s.kind === 'rect').reduce((widest, s) => (s.width > widest.width ? s : widest));

      expect(capeShape(withA).color).toBe(capeShape(withB).color);
    });

    // "A project's agents share that colour": an orchestrator and a subagent of the SAME project
    // must share the same torso colour — the visual family link this whole feature is about.
    it('shares the same torso colour between an orchestrator and a subagent of the same project', () => {
      const orchestrator = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const subagent = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });

      // For an orchestrator, the cape (widest rect) sits in front of the torso (second-widest).
      const orchestratorRects = orchestrator.filter((s) => s.kind === 'rect').sort((a, b) => b.width - a.width);
      const orchestratorTorso = orchestratorRects[1]!;

      expect(orchestratorTorso.color).toBe(torsoShape(subagent).color);
    });
  });

  describe('facing — mirrors the figure horizontally', () => {
    it('defaults to right (unmirrored) when facing is not given', () => {
      const withoutFacing = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A });
      const explicitRight = buildCharacterPose({ role: 'subagent', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A, facing: 'right' });

      expect(withoutFacing).toEqual(explicitRight);
    });

    it('negates the x of every shape when facing left, leaving y untouched', () => {
      const right = buildCharacterPose({ role: 'subagent', state: 'walking', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A, facing: 'right' });
      const left = buildCharacterPose({ role: 'subagent', state: 'walking', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A, facing: 'left' });

      expect(left).toHaveLength(right.length);
      for (let i = 0; i < right.length; i++) {
        expect(left[i]!.x).toBe(-right[i]!.x);
        expect(left[i]!.y).toBe(right[i]!.y);
      }
    });

    // Adversarial twin: mirroring an orchestrator must still keep the exact same shape COUNT (the
    // cape) — mirroring is a pure coordinate transform, never a structural change.
    it('keeps the same shape count for an orchestrator when facing left', () => {
      const right = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A, facing: 'right' });
      const left = buildCharacterPose({ role: 'orchestrator', state: 'idle', frame: 0, accentColor: ACCENT_A, bodyColor: BODY_A, facing: 'left' });

      expect(left.length).toBe(right.length);
    });
  });
});
