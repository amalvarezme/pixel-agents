/**
 * Pixel Office character pack — the PURE half of sprite rendering. No PixiJS, no DOM, no file I/O
 * (dependency-cruiser's `pixi-only-in-scene-pixi` rule keeps every geometry decision testable
 * without a canvas). Everything here decides WHICH frame of WHICH sheet to draw and WHERE to pin
 * it; `ui/scene/pixi/sprite-character-renderer.ts` is the only module that turns those numbers
 * into textures.
 *
 * The pack ships four 32x32 characters, each a 4-column x 8-row sheet, with a per-character JSON
 * declaring every clip's row/frames/fps/loop (`docs/characters/GUIA_AGENTE_PIXEL_OFFICE.md`).
 * That JSON is the source of truth for animation timing — section 6 of the guide and section 32's
 * priority list both say so, so `selectSpriteFrame` takes the clip metadata rather than consulting
 * a table of its own. `ui/scene/character/animation-clock.ts` keeps its hardcoded frame counts for
 * the procedural fallback figure, which has no JSON to read.
 */
import type { AgentRole } from '../../../domain/agents/agent-profile';
import type { CharacterAnimationState } from './animation-state';

export const CHARACTER_IDS = ['alex', 'marcus', 'sophia', 'elena'] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];

/** Every clip the pack ships, in sheet-row order (guide section 4). */
export const SPRITE_ANIMATIONS = ['idle', 'walk', 'work', 'typing', 'talk', 'point', 'celebrate', 'sit'] as const;
export type SpriteAnimationName = (typeof SPRITE_ANIMATIONS)[number];

/** One clip's entry in a character's JSON. Mirrors the shipped shape exactly. */
export interface SpriteClipMeta {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
}

/** A character's JSON file (`public/characters/<id>/<id>.json`). */
export interface CharacterSpriteMeta {
  name: string;
  displayName: string;
  role: string;
  image: string;
  frameWidth: number;
  frameHeight: number;
  sheetWidth: number;
  sheetHeight: number;
  animations: Record<string, SpriteClipMeta>;
}

/**
 * Scale factor per role. Whole numbers only — guide section 9 is explicit that a fractional scale
 * destroys pixel-perfect rendering, and section 32 ranks preserving it third out of six. The
 * orchestrator is drawn larger than the subagents of the SAME character, which is how role stays
 * readable at a glance without changing who the character is.
 *
 * The actual numbers come from looking at the rendered office, not from theory. At 3x/2x on the
 * fixed 1920x1080 floor plan a subagent cleared its 40-unit desk by barely a head, which reads as
 * a blob rather than a person — the same "readable at a glance" defect commit e7bb2ca had to fix
 * once already for the procedural figure. Only rows 0..20 of a desk-bearing frame sit above the
 * desk surface, so the visible height is `21 * scale`: 105 units for an orchestrator, 63 for a
 * subagent.
 */
export const ROLE_SPRITE_SCALE: Record<AgentRole, number> = { orchestrator: 5, subagent: 3 };

/**
 * Row (0-based, in 32px frame units) where the pack's OWN desk surface is drawn inside the
 * `work`/`typing`/`sit` frames. Measured, not guessed: scanning every shipped PNG for the table
 * colour puts its top edge on row 21 in all three clips, all four frames, all four characters.
 * `character-sprite.test.ts` re-reads the shipped JSON so a repacked asset set cannot silently
 * drift away from this number.
 */
export const DESK_LINE_ROW = 21;

/**
 * Row the feet stand on in the desk-free clips. The lowest opaque row in those frames is 30, so
 * the standing line is the row directly below it.
 */
export const GROUND_LINE_ROW = 31;

const DESK_BEARING_ANIMATIONS = new Set<SpriteAnimationName>(['work', 'typing', 'sit']);

/**
 * Which scene line a clip pins to, and which of its own rows lands exactly on that line.
 *
 * The pack draws a desk INTO the `work`/`typing`/`sit` frames. Standing those on the floor like
 * any other clip would put a second desk next to the one the scene already draws, so they pin by
 * their built-in table line to the scene's desk surface instead — the two tables become one plane
 * and the laptop reads as sitting on the desk the office already has.
 */
export interface SpriteAnchor {
  reference: 'desk-surface' | 'floor';
  row: number;
}

export function resolveSpriteAnchor(animation: SpriteAnimationName): SpriteAnchor {
  return DESK_BEARING_ANIMATIONS.has(animation)
    ? { reference: 'desk-surface', row: DESK_LINE_ROW }
    : { reference: 'floor', row: GROUND_LINE_ROW };
}

export interface SpriteAnimationInput {
  state: CharacterAnimationState;
  /** True only while the worker is dwelling at the archive cabinet (`ArchiveTripView.highlight`). */
  atArchive?: boolean;
}

/**
 * Maps the scene's own three-state animation vocabulary onto the pack's eight clips, following
 * the guide's suggested office sequence (section 13: walk -> sit -> work -> typing -> celebrate).
 *
 * `working`/`idle` both pick a DESK-BEARING clip because a worker in either state is at its desk;
 * the difference a viewer needs to see is typing hands versus a still figure, not a change of
 * furniture. Arrival at the archive outranks everything: it is the one moment in the whole scene
 * worth celebrating, and it is brief.
 */
export function selectSpriteAnimation(input: SpriteAnimationInput): SpriteAnimationName {
  if (input.atArchive) return 'celebrate';
  if (input.state === 'walking') return 'walk';
  return input.state === 'working' ? 'typing' : 'sit';
}

/**
 * Frame index for `clip` at clock reading `elapsedMs`, honouring the clip's OWN fps and loop flag
 * from the pack JSON.
 *
 * A non-looping clip holds its final frame rather than wrapping. The scene has no per-worker
 * animation epoch to restart `celebrate` from, so in practice that clip settles on its last frame
 * — a held celebratory pose for the length of the archive dwell, which is the honest reading of
 * `loop: false` rather than quietly looping a clip the pack says plays once.
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
 * Source rectangle inside the sheet, exactly as the guide's section 7 defines it:
 * `sx = frameIndex * frameWidth`, `sy = animation.row * frameHeight`. An animation the metadata
 * does not declare falls back to row 0 rather than producing `NaN` coordinates that would read
 * garbage off the sheet.
 */
export function computeSpriteFrameRect(meta: CharacterSpriteMeta, animation: string, frame: number): SpriteFrameRect {
  const row = meta.animations[animation]?.row ?? 0;
  return {
    x: frame * meta.frameWidth,
    y: row * meta.frameHeight,
    width: meta.frameWidth,
    height: meta.frameHeight,
  };
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
  return `${assetRoot}/${id}/${id}_spritesheet.png`;
}

/** Path of a character's portrait (guide section 20: panels and tooltips, never the scene). */
export function characterPortraitUrl(id: CharacterId, assetRoot = '/characters'): string {
  return `${assetRoot}/${id}/${id}_portrait.png`;
}

/** Path of a character's metadata JSON, the source of truth for every clip's timing. */
export function characterMetaUrl(id: CharacterId, assetRoot = '/characters'): string {
  return `${assetRoot}/${id}/${id}.json`;
}
