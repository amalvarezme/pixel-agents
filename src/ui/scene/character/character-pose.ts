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
 */
import type { AgentRole } from '../../../domain/agents/agent-profile';
import type { CharacterAnimationState } from './animation-state';

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

const TORSO_COLOR = 0x3a3a4a;
const LIMB_COLOR = 0x2b2b38;
const SKIN_COLOR = 0xe0b088;
/** Fixed role marker — orchestrator-only, independent of the per-model accent colour, so "which
 * worker is the orchestrator" reads at a glance regardless of which model is running it. */
const ORCHESTRATOR_ACCENT_COLOR = 0xffd166;

// Amplitudes are in SCENE units on the fixed 1920-wide floor plan, which `fitToViewport` scales
// down to the viewport — on a 1512px-wide canvas that is roughly 0.79 px per unit. The original
// values (2 / 4 / 6) were measured as ~1.6 / ~3.2 / ~4.7 px on screen: real motion, verified
// cycling at the data layer, and imperceptible to a person glancing at the office. These are sized
// so the state is readable at a glance, which is the whole job of this display.
const IDLE_BOB_OFFSET = 6;
const WORKING_ARM_LIFT = 14;
const WALKING_STRIDE_OFFSET = 18;

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

/** Builds the drawable shape list for one worker's character at one animation frame. Pure and
 * deterministic — the same params always produce the same shapes. */
export function buildCharacterPose(params: CharacterPoseParams): CharacterShape[] {
  const { role, state, frame, accentColor } = params;
  const bob = idleBob(state, frame);
  const arms = workingArmLift(state, frame);
  const stride = walkingStride(state, frame);

  const legTop = -LEG_HEIGHT + bob;
  const legBottom = bob;
  const torsoTop = legTop - TORSO_HEIGHT;
  const armTop = torsoTop;
  const headBottom = torsoTop;
  const headTop = headBottom - HEAD_SIZE;

  const shapes: CharacterShape[] = [];

  // Orchestrator vs subagent: a supervisor "cape" panel behind the torso, drawn first so it sits
  // behind everything else — the one structural difference that makes an orchestrator visibly
  // different from a subagent regardless of animation state or model.
  if (role === 'orchestrator') {
    shapes.push({
      kind: 'rect',
      x: 0,
      y: (torsoTop + legTop) / 2,
      width: TORSO_WIDTH + CAPE_PADDING * 2,
      height: TORSO_HEIGHT + CAPE_PADDING,
      color: ORCHESTRATOR_ACCENT_COLOR,
    });
  }

  shapes.push(
    { kind: 'rect', x: -(LEG_GAP / 2 + LEG_WIDTH / 2) + stride.left, y: (legTop + legBottom) / 2, width: LEG_WIDTH, height: LEG_HEIGHT, color: LIMB_COLOR },
    { kind: 'rect', x: LEG_GAP / 2 + LEG_WIDTH / 2 + stride.right, y: (legTop + legBottom) / 2, width: LEG_WIDTH, height: LEG_HEIGHT, color: LIMB_COLOR },
    { kind: 'rect', x: 0, y: (torsoTop + legTop) / 2, width: TORSO_WIDTH, height: TORSO_HEIGHT, color: TORSO_COLOR },
    {
      kind: 'rect',
      x: -(TORSO_WIDTH / 2 + ARM_GAP + ARM_WIDTH / 2),
      y: armTop + ARM_HEIGHT / 2 + arms.left,
      width: ARM_WIDTH,
      height: ARM_HEIGHT,
      color: LIMB_COLOR,
    },
    {
      kind: 'rect',
      x: TORSO_WIDTH / 2 + ARM_GAP + ARM_WIDTH / 2,
      y: armTop + ARM_HEIGHT / 2 + arms.right,
      width: ARM_WIDTH,
      height: ARM_HEIGHT,
      color: LIMB_COLOR,
    },
    { kind: 'circle', x: 0, y: (headTop + headBottom) / 2, width: HEAD_SIZE, height: HEAD_SIZE, color: SKIN_COLOR },
    { kind: 'circle', x: 0, y: headTop - BADGE_GAP - BADGE_SIZE / 2, width: BADGE_SIZE, height: BADGE_SIZE, color: accentColor },
  );

  return shapes;
}
