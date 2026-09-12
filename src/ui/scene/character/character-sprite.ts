/**
 * Pixel Office v2 character pack — the PURE half of sprite rendering. No PixiJS, no DOM, no file
 * I/O (dependency-cruiser's `pixi-only-in-scene-pixi` rule keeps every geometry decision testable
 * without a canvas). Everything here decides WHICH frame of WHICH sheet to draw and WHERE to pin
 * it; `ui/scene/pixi/sprite-character-renderer.ts` is the only module that turns those numbers
 * into textures.
 *
 * What v2 changed, and why this module was rewritten rather than patched
 * (`docs/pixel-office/IMPLEMENTACION_AGENTE_CODIGO.md` section 5):
 * - Sprites are BODY-ONLY. v1 drew a desk, a laptop and a chair into the `work`/`typing`/`sit`
 *   frames, which forced the old anchor table pinning a frame ROW onto the scene's desk surface.
 *   Furniture now belongs to the environment, so every clip anchors the same way: feet on the
 *   floor, at the character's own declared `origin`.
 * - Clips are DIRECTIONAL. `animations[action]` is no longer one clip but a map of `down`/`up`/
 *   `side` clips, so a character can face its workstation, the room, or the way it is walking.
 * - `left` is a runtime MIRROR of `side` (the pack draws `side` facing right and says so in
 *   `sideFaces`); shipping a second set of art for it is explicitly forbidden.
 *
 * The per-character JSON remains the source of truth for row/frames/fps/loop — section 2 of the
 * guide ("no codificar manualmente FPS, filas del spritesheet, anchors") — so nothing here carries
 * a table of its own; `character-sprite.test.ts` re-reads the shipped JSON so a repacked asset set
 * cannot silently drift away from the assumptions the renderer makes.
 */
import type { AgentRole } from '../../../domain/agents/agent-profile';
import { depthScaleFor } from '../world/office-map';
import type { CharacterAnimationState } from './animation-state';

export const CHARACTER_IDS = ['alex', 'marcus', 'sophia', 'elena'] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];

/** Every action the pack ships (guide section 5). */
export const SPRITE_ACTIONS = ['idle', 'walk', 'work', 'typing', 'talk', 'point', 'celebrate', 'sit'] as const;
export type SpriteAction = (typeof SPRITE_ACTIONS)[number];

/** The directions the pack actually DRAWS. `side` is drawn facing right (`meta.sideFaces`). */
export type SpriteDirection = 'down' | 'up' | 'side';

/** The directions a character can logically face. `left` resolves to a mirrored `side` clip. */
export type CharacterDirection = 'down' | 'up' | 'left' | 'right';

/** One clip's entry in a character's JSON. Mirrors the shipped shape exactly. */
export interface SpriteClipMeta {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
  /** Declared by the pack on every `side` clip; the renderer honours `resolveSpriteClip`'s own
   * `mirror` flag rather than this field, which exists to document the asset's intent. */
  mirrorForLeft?: boolean;
}

/** A character's JSON file (`public/characters/<id>/<id>.json`). */
export interface CharacterSpriteMeta {
  /** `2` for every file in this pack; asserted by the test so a v1 drop-in fails loudly. */
  schemaVersion?: number;
  id: string;
  displayName: string;
  role: string;
  image: string;
  frameWidth: number;
  frameHeight: number;
  sheetWidth: number;
  sheetHeight: number;
  /** The character's logical position IN FRAME PIXELS: the centre of its feet, not the frame's
   * top-left corner (guide section 5). `(agent.x, agent.y)` is this point. */
  origin: { x: number; y: number };
  /** Small box around the feet used for navigation collisions — deliberately NOT the full 32x32
   * frame, so head and torso can overlap a desk or a plant without blocking the floor
   * (guide section 13). Unused by the renderer; consumed by the navigation layer. */
  hitbox?: { offsetX: number; offsetY: number; width: number; height: number };
  defaultScale: number;
  defaultDirection: CharacterDirection;
  sideFaces: 'right' | 'left';
  animations: Record<string, Record<string, SpriteClipMeta>>;
  /** Which direction to fall back to for an action the pack draws only one way — `work`/`typing`
   * exist only as `up`, `celebrate`/`sit` only as `down`. */
  fallbackDirections?: Record<string, SpriteDirection>;
}

/**
 * How much BIGGER an orchestrator is drawn than a subagent standing in the same place. A whole
 * number added to the map's depth scale, never a ratio multiplied into it: guide section 6 is
 * explicit that a fractional scale destroys pixel-perfect rendering, and the map's own bands are
 * already whole numbers.
 *
 * One step is enough to read: at the room's depth scales that is a third again as tall, on a
 * figure whose whole body is visible (v2 sprites carry no desk of their own).
 */
export const ROLE_SCALE_BONUS: Record<AgentRole, number> = { orchestrator: 1, subagent: 0 };

/**
 * One whole step added to every character, on top of the map's perspective band.
 *
 * The map's bands are written for a scene you look AT; this one is a monitor you glance at. At the
 * shipped band values a back-row agent is 64px tall in a 1672x941 room full of detailed furniture
 * and reads as part of the artwork rather than as a person — the same "readable at a glance"
 * defect commit e7bb2ca had to fix once already for the procedural figure. A whole step keeps the
 * art pixel-perfect (guide section 6) and keeps the room's own depth ordering intact, because it
 * is added to every band equally.
 */
const READABILITY_BONUS = 1;

/**
 * The scale one character is drawn at: perspective from where its feet are (the map's
 * `depth.scaleBands`), plus the readability step, plus its role's whole-number bonus.
 *
 * Both readings land on the same figure on purpose. Depth alone would make a subagent at the front
 * of the room bigger than its orchestrator at the back, which is true of perspective and useless
 * as information; role alone would make a character at the back the same size as one at the front,
 * which would break the room's depth. Adding them keeps perspective intact and still leaves the
 * orchestrator the larger of any two agents standing together.
 */
export function resolveCharacterScale(footY: number, role: AgentRole): number {
  return depthScaleFor(footY) + READABILITY_BONUS + ROLE_SCALE_BONUS[role];
}

/**
 * The character's drawn footprint at `scale`, as offsets from its origin (the centre of its feet)
 * — what a hover hit-test needs and the only place the body's measured pixel bounds live.
 *
 * Measured from the shipped sheets rather than assumed: every clip of every character draws its
 * body inside columns 7..24 and rows 1..30 of the 32px frame, with the origin at column 16,
 * row 30. The `point` clips reach further right (an extended arm), deliberately ignored here — a
 * hover target should be the person, not the gesture.
 */
export const CHARACTER_BODY_HALF_WIDTH = 9;
export const CHARACTER_BODY_HEIGHT = 30;

export interface ResolvedSpriteClip {
  clip: SpriteClipMeta;
  /** The direction actually DRAWN, after `left`/`right` collapse onto `side` and after any
   * fallback. */
  direction: SpriteDirection;
  /** True when the caller must flip the frame horizontally about the character's origin. */
  mirror: boolean;
}

/**
 * Port of the pack's own `CharacterAnimator.resolve` (`04_engine/CharacterAnimator.js`), with one
 * deliberate difference: an unknown action returns `null` instead of throwing, because the scene
 * must degrade to another clip rather than take the whole render loop down with it.
 *
 * Resolution order, exactly as the pack defines it: `left`/`right` collapse onto the single drawn
 * `side` clip, an action that does not draw the requested direction falls back to
 * `fallbackDirections[action]` (then to whatever direction the action does draw), and `mirror` is
 * set only for a `left` request answered by a `side` clip.
 */
export function resolveSpriteClip(
  meta: CharacterSpriteMeta,
  action: string,
  direction: CharacterDirection,
): ResolvedSpriteClip | null {
  const group = meta.animations[action];
  if (!group) return null;

  const requested: SpriteDirection = direction === 'left' || direction === 'right' ? 'side' : direction;
  let resolved: SpriteDirection = requested;
  let clip = group[requested];

  if (!clip) {
    const fallback = meta.fallbackDirections?.[action] ?? (Object.keys(group)[0] as SpriteDirection | undefined);
    if (!fallback) return null;
    resolved = fallback;
    clip = group[fallback];
  }
  if (!clip) return null;

  return { clip, direction: resolved, mirror: direction === 'left' && resolved === 'side' };
}

export interface SpritePose {
  action: SpriteAction;
  direction: CharacterDirection;
}

export interface SpritePoseInput {
  state: CharacterAnimationState;
  /** True only while the worker is dwelling at the Persistent Memory Archive. */
  atArchive?: boolean;
  /** Where the character is currently heading. Only read while walking; the other states are
   * pinned to the direction their station or the room demands. */
  direction?: CharacterDirection;
}

/**
 * Maps the scene's three-state animation vocabulary onto the pack's directional clips.
 *
 * Every choice here comes from the map and the guide rather than taste:
 * - the Persistent Memory Archive declares `defaultAnimation: "point"` and `facing: "up"`
 *   (`office_map.json` `specialZones.persistent_memory`), and guide section 9 maps every
 *   `read_memory`/`write_memory` action onto `point` until dedicated clips exist. Reaching the
 *   archive outranks everything else: it is the one moment in the scene worth showing.
 * - a workstation declares `defaultAnimation: "typing"` and `facing: "up"`, so a working agent
 *   faces its laptop with its back to the viewer.
 * - an idle agent turns AWAY from the laptop, toward the room (`down`). That is the difference a
 *   viewer needs to read at a glance — hands on keys versus a figure facing the floor — and it is
 *   also the only way the character's face, and therefore its project identity, is ever visible.
 */
export function selectSpritePose(input: SpritePoseInput): SpritePose {
  if (input.atArchive) return { action: 'point', direction: 'up' };
  if (input.state === 'walking') return { action: 'walk', direction: input.direction ?? 'down' };
  if (input.state === 'working') return { action: 'typing', direction: 'up' };
  return { action: 'idle', direction: 'down' };
}

/**
 * Frame index for `clip` at clock reading `elapsedMs`, honouring the clip's OWN fps and loop flag
 * from the pack JSON.
 *
 * A non-looping clip holds its final frame rather than wrapping. The scene has no per-worker
 * animation epoch to restart such a clip from, so in practice it settles on its last frame — the
 * honest reading of `loop: false` rather than quietly looping a clip the pack says plays once.
 */
export function selectSpriteFrame(clip: SpriteClipMeta, elapsedMs: number): number {
  const frameDurationMs = 1000 / clip.fps;
  const index = Math.floor(Math.max(0, elapsedMs) / frameDurationMs);
  return clip.loop ? index % clip.frames : Math.min(index, clip.frames - 1);
}

export interface SpriteFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Source rectangle inside the sheet: `sx = frameIndex * frameWidth`, `sy = clip.row * frameHeight`
 * — the same arithmetic `CharacterAnimator.draw` uses. Takes the already-resolved CLIP rather than
 * an action name, because in v2 an action alone no longer identifies a row.
 */
export function computeSpriteFrameRect(meta: CharacterSpriteMeta, clip: SpriteClipMeta, frame: number): SpriteFrameRect {
  return {
    x: frame * meta.frameWidth,
    y: clip.row * meta.frameHeight,
    width: meta.frameWidth,
    height: meta.frameHeight,
  };
}

/**
 * The character's `origin` expressed as a NORMALIZED anchor (0..1 of the frame), which is how a
 * sprite renderer pins a texture to a point.
 *
 * Anchoring on the origin rather than offsetting a top-left corner is what makes mirroring free:
 * a horizontal flip about the anchor keeps the feet in exactly the same place, which is precisely
 * what the pack's own `ctx.scale(-1, 1)`-around-the-origin draw call does.
 */
export function spriteAnchorPoint(meta: CharacterSpriteMeta): { x: number; y: number } {
  return { x: meta.origin.x / meta.frameWidth, y: meta.origin.y / meta.frameHeight };
}

/**
 * Deterministic project -> character assignment, the same hash-into-a-fixed-TABLE shape
 * `project-accent.ts` and `model-accent.ts` already use — never an `if (projectPath === ...)`
 * chain. Resolved from `projectPath` ALONE, so an orchestrator and every subagent under the same
 * project are always the same character; role changes only the scale (`ROLE_SPRITE_SCALE`).
 *
 * A worker with no known project (Antigravity reports none) gets a fixed character rather than a
 * per-call guess. Unlike `project-accent.ts`, which reserves a neutral colour outside its palette,
 * there is no fifth sprite to reserve — so this one deliberately overlaps with whichever project
 * happens to hash to it, and the tooltip's Project row stays the authority on identity.
 */
function hashProjectPath(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function resolveCharacterId(projectPath?: string): CharacterId {
  if (!projectPath || projectPath.trim().length === 0) return CHARACTER_IDS[0];
  return CHARACTER_IDS[hashProjectPath(projectPath) % CHARACTER_IDS.length]!;
}

/** Path of a character's sheet under the served asset root, so no caller hand-builds one. */
export function characterSheetUrl(id: CharacterId, assetRoot = '/characters'): string {
  return `${assetRoot}/${id}/${id}_spritesheet_v2.png`;
}

/** Path of a character's portrait (guide section 20 of the v1 pack, kept in v2: panels and
 * tooltips, never the scene). */
export function characterPortraitUrl(id: CharacterId, assetRoot = '/characters'): string {
  return `${assetRoot}/${id}/${id}_portrait_v2.png`;
}

/** Path of a character's metadata JSON, the source of truth for every clip's timing. */
export function characterMetaUrl(id: CharacterId, assetRoot = '/characters'): string {
  return `${assetRoot}/${id}/${id}.json`;
}
