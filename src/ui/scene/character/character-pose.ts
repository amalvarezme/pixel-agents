/**
 * Character geometry — a procedurally-drawn 2D pixel-art figure, built entirely from primitive
 * shapes (rectangles/circles). Pure data + pure functions, deliberately OUTSIDE `ui/scene/pixi/`
 * so it stays testable without a canvas (dependency-cruiser's `pixi-only-in-scene-pixi` rule
 * forbids importing pixi.js here) — `ui/scene/pixi/character-renderer.ts` is the only place a
 * `CharacterShape[]` becomes an actual PixiJS draw call.
 *
 * Deliberately original and generic (head/torso/arms/legs blocks, roughly a 16x24 pixel-art grid
 * scaled up for readability against the scene's much larger desk/floor units) — no recognisable
 * commercial character, no external asset, no ripped sprite.
 *
 * One character FAMILY, two axes of variation, both deliberately independent of each other:
 *  - ROLE sets SIZE (`ROLE_SCALE`) — an orchestrator is the SAME character design as its
 *    subagents, just drawn larger, plus its own fixed "cape" panel (a role marker, unrelated to
 *    size or colour).
 *  - PROJECT sets COLOUR (`bodyColor`, resolved upstream by `project-accent.ts`) — every worker
 *    under the same project shares one torso colour and a derived, darker limb tone, so the
 *    family reads at a glance regardless of role or which model is running it.
 */
import type { AgentRole } from '../../../domain/agents/agent-profile';
import type { CharacterAnimationState } from './animation-state';
import type { CharacterFacing } from './character-facing';

export interface CharacterShape {
  kind: 'rect' | 'circle';
  /** Offset from the character's origin (feet, ground-level centre). Negative y is up. */
  x: number;
  y: number;
  /** Diameter for a circle. */
  width: number;
  height: number;
  color: number;
}

export interface CharacterPoseParams {
  role: AgentRole;
  state: CharacterAnimationState;
  frame: number;
  /** Small badge/colour accent distinguishing the running model (`resolveModelAccentColor`). */
  accentColor: number;
  /** The project's character colour (`resolveProjectCharacterColor`) — paints the torso; the limb
   * tone is a derived, darker shade of this same colour so the whole figure reads as one coloured
   * character, not a coloured shirt on a fixed grey body. */
  bodyColor: number;
  /** Which way the figure faces — mirrors every shape horizontally when `'left'`. Defaults to
   * `'right'` so a caller that never specifies it keeps today's unmirrored output. */
  facing?: CharacterFacing;
}

const LEG_WIDTH = 10;
const LEG_HEIGHT = 46;
const LEG_GAP = 6;
const TORSO_WIDTH = 34;
const TORSO_HEIGHT = 46;
const ARM_WIDTH = 10;
const ARM_HEIGHT = 40;
const ARM_GAP = 3;
const HEAD_SIZE = 28;
const BADGE_SIZE = 10;
const BADGE_GAP = 4;
const CAPE_PADDING = 8;

/**
 * Role sets SIZE, not shape: the orchestrator is the SAME character design as a subagent, just
 * drawn larger — every dimension constant above (and every animation amplitude below) is derived
 * from this ONE factor per role, never a hand-tuned second set of constants. `1` would be the
 * unscaled baseline; subagent is drawn slightly below it and orchestrator clearly above it so the
 * two read as "large supervisor, smaller worker" at a glance.
 */
const ROLE_SCALE: Record<AgentRole, number> = {
  orchestrator: 1.4,
  subagent: 0.85,
};

const SKIN_COLOR = 0xe0b088;
/** Fixed role marker — orchestrator-only, independent of both the per-model accent colour AND the
 * per-project body colour, so "which worker is the orchestrator" reads at a glance regardless of
 * which model is running it or which project it belongs to. */
const ORCHESTRATOR_ACCENT_COLOR = 0xffd166;
/** How much darker the derived limb tone is than the project's own bodyColor (1 = identical, 0 =
 * black) — dark enough to read as a distinct "shirt vs skin/limb" contrast, light enough to still
 * visibly share the same hue as the torso. */
const LIMB_SHADE_FACTOR = 0.6;

// Amplitudes are in SCENE units on the fixed 1920-wide floor plan, which `fitToViewport` scales
// down to the viewport — on a 1512px-wide canvas that is roughly 0.79 px per unit. The original
// values (2 / 4 / 6) were measured as ~1.6 / ~3.2 / ~4.7 px on screen: real motion, verified
// cycling at the data layer, and imperceptible to a person glancing at the office. These are sized
// so the state is readable at a glance, which is the whole job of this display. Like every other
// dimension, they are scaled by `ROLE_SCALE` before use, so a larger orchestrator's motion reads
// at the same PROPORTIONAL amplitude as a subagent's, not a fixed absolute one.
const IDLE_BOB_OFFSET = 6;
const WORKING_ARM_LIFT = 14;
const WALKING_STRIDE_OFFSET = 18;
/** Vertical arm-swing amplitude while walking, counter to the leg stride — makes the figure read
 * as actually walking instead of sliding with only its legs moving. */
const WALKING_ARM_SWING_OFFSET = 10;

/** Subtle breathing bob: the whole figure lifts by one offset on the second idle frame. */
function idleBob(state: CharacterAnimationState, frame: number): number {
  return state === 'idle' && frame % 2 === 1 ? -IDLE_BOB_OFFSET : 0;
}

/** Typing motion: alternates which arm is raised toward the desk. */
function workingArmLift(state: CharacterAnimationState, frame: number): { left: number; right: number } {
  if (state !== 'working') return { left: 0, right: 0 };
  return frame % 2 === 0 ? { left: -WORKING_ARM_LIFT, right: 0 } : { left: 0, right: -WORKING_ARM_LIFT };
}

/** Walk cycle: legs swing to opposite horizontal offsets, passing through a neutral stance. */
function walkingStride(state: CharacterAnimationState, frame: number): { left: number; right: number } {
  if (state !== 'walking') return { left: 0, right: 0 };
  const phase = frame % 4;
  if (phase === 0) return { left: WALKING_STRIDE_OFFSET, right: -WALKING_STRIDE_OFFSET };
  if (phase === 2) return { left: -WALKING_STRIDE_OFFSET, right: WALKING_STRIDE_OFFSET };
  return { left: 0, right: 0 };
}

/** Arm counter-swing: on the SAME 4-phase cycle as `walkingStride`, but vertical and with the
 * opposite sign from the leg on the same side, so the arms visibly counter-swing against the legs
 * instead of the figure sliding with only its legs moving. */
function walkingArmSwing(state: CharacterAnimationState, frame: number): { left: number; right: number } {
  if (state !== 'walking') return { left: 0, right: 0 };
  const phase = frame % 4;
  if (phase === 0) return { left: -WALKING_ARM_SWING_OFFSET, right: WALKING_ARM_SWING_OFFSET };
  if (phase === 2) return { left: WALKING_ARM_SWING_OFFSET, right: -WALKING_ARM_SWING_OFFSET };
  return { left: 0, right: 0 };
}

/** Derives the limb tone from the project's bodyColor — a darker shade of that SAME colour, so
 * the whole figure reads as one coloured character (its own darker limbs) rather than a coloured
 * shirt on a fixed grey body. */
function darkenColor(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/** Builds the drawable shape list for one worker's character at one animation frame. Pure and
 * deterministic — the same params always produce the same shapes. */
export function buildCharacterPose(params: CharacterPoseParams): CharacterShape[] {
  const { role, state, frame, accentColor, bodyColor } = params;
  const facing = params.facing ?? 'right';
  const scale = ROLE_SCALE[role];

  const bob = idleBob(state, frame) * scale;
  const armLift = workingArmLift(state, frame);
  const armSwing = walkingArmSwing(state, frame);
  const arms = {
    left: (armLift.left + armSwing.left) * scale,
    right: (armLift.right + armSwing.right) * scale,
  };
  const strideRaw = walkingStride(state, frame);
  const stride = { left: strideRaw.left * scale, right: strideRaw.right * scale };

  const legWidth = LEG_WIDTH * scale;
  const legHeight = LEG_HEIGHT * scale;
  const legGap = LEG_GAP * scale;
  const torsoWidth = TORSO_WIDTH * scale;
  const torsoHeight = TORSO_HEIGHT * scale;
  const armWidth = ARM_WIDTH * scale;
  const armHeight = ARM_HEIGHT * scale;
  const armGap = ARM_GAP * scale;
  const headSize = HEAD_SIZE * scale;
  const badgeSize = BADGE_SIZE * scale;
  const badgeGap = BADGE_GAP * scale;
  const capePadding = CAPE_PADDING * scale;

  const legTop = -legHeight + bob;
  const legBottom = bob;
  const torsoTop = legTop - torsoHeight;
  const armTop = torsoTop;
  const headBottom = torsoTop;
  const headTop = headBottom - headSize;

  const limbColor = darkenColor(bodyColor, LIMB_SHADE_FACTOR);

  const shapes: CharacterShape[] = [];

  // Orchestrator vs subagent: a supervisor "cape" panel behind the torso, drawn first so it sits
  // behind everything else — the one structural difference that makes an orchestrator visibly
  // different from a subagent regardless of animation state, model, or project colour.
  if (role === 'orchestrator') {
    shapes.push({
      kind: 'rect',
      x: 0,
      y: (torsoTop + legTop) / 2,
      width: torsoWidth + capePadding * 2,
      height: torsoHeight + capePadding,
      color: ORCHESTRATOR_ACCENT_COLOR,
    });
  }

  shapes.push(
    { kind: 'rect', x: -(legGap / 2 + legWidth / 2) + stride.left, y: (legTop + legBottom) / 2, width: legWidth, height: legHeight, color: limbColor },
    { kind: 'rect', x: legGap / 2 + legWidth / 2 + stride.right, y: (legTop + legBottom) / 2, width: legWidth, height: legHeight, color: limbColor },
    { kind: 'rect', x: 0, y: (torsoTop + legTop) / 2, width: torsoWidth, height: torsoHeight, color: bodyColor },
    {
      kind: 'rect',
      x: -(torsoWidth / 2 + armGap + armWidth / 2),
      y: armTop + armHeight / 2 + arms.left,
      width: armWidth,
      height: armHeight,
      color: limbColor,
    },
    {
      kind: 'rect',
      x: torsoWidth / 2 + armGap + armWidth / 2,
      y: armTop + armHeight / 2 + arms.right,
      width: armWidth,
      height: armHeight,
      color: limbColor,
    },
    { kind: 'circle', x: 0, y: (headTop + headBottom) / 2, width: headSize, height: headSize, color: SKIN_COLOR },
    { kind: 'circle', x: 0, y: headTop - badgeGap - badgeSize / 2, width: badgeSize, height: badgeSize, color: accentColor },
  );

  // Facing mirrors the whole figure horizontally: negate x, leave y (vertical position) untouched.
  return facing === 'left' ? shapes.map((shape) => ({ ...shape, x: -shape.x })) : shapes;
}
