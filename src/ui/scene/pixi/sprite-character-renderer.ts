/**
 * Turns the Pixel Office character pack into PixiJS sprites. Part of `ui/scene/pixi/`, the only
 * directory allowed to import `pixi.js` (design.md D3) — every decision this file acts on was
 * already made, and unit-tested without a canvas, in `ui/scene/character/character-sprite.ts`.
 *
 * Two halves, the same split `pixi-office-renderer.ts` already uses:
 * - `CharacterAtlas.load` is the browser-only part: `Assets.load` over four PNG sheets and four
 *   JSON metadata files. It cannot run under vitest (no fetch, no GPU), so it is verified by
 *   loading the page, exactly like `PixiOfficeRenderer.mount`.
 * - `renderSpriteCharacter` is pure scene-graph assembly on an already-loaded atlas. The scene
 *   calls it only when an atlas exists; with no atlas the office falls back to the procedural
 *   figure (`character-pose.ts`), so a failed or slow asset load degrades the art, never the app.
 *
 * Sub-frame textures are CACHED per (character, animation, frame). Without that, the per-frame
 * scene rebuild would allocate a fresh `Texture` for every worker 60 times a second.
 */
import { Assets, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { AgentRole } from '../../../domain/agents/agent-profile';
import type { CharacterAnimationState } from '../character/animation-state';
import type { CharacterFacing } from '../character/character-facing';
import {
  CHARACTER_IDS,
  ROLE_SPRITE_SCALE,
  characterMetaUrl,
  characterSheetUrl,
  computeSpriteFrameRect,
  resolveCharacterId,
  resolveSpriteAnchor,
  selectSpriteAnimation,
  selectSpriteFrame,
  type CharacterId,
  type CharacterSpriteMeta,
  type SpriteAnimationName,
} from '../character/character-sprite';

/**
 * Opacity of a worker whose session has gone quiet. design.md "Session discovery and aging out"
 * describes the idle state as "worker dims, stays on stage" — this is that dimming. Deliberately
 * not so faint that the character stops being readable: an idle agent is still information.
 */
export const IDLE_CHARACTER_ALPHA = 0.55;

interface LoadedCharacter {
  meta: CharacterSpriteMeta;
  sheet: Texture;
}

export class CharacterAtlas {
  private readonly frameCache = new Map<string, Texture>();

  private constructor(private readonly characters: Map<CharacterId, LoadedCharacter>) {}

  /**
   * Loads every character the pack ships. Returns `null` when nothing could be loaded, which the
   * scene reads as "draw the procedural figure instead" — a missing or mis-served asset directory
   * must never leave the office empty. A partial load keeps whatever succeeded.
   */
  static async load(assetRoot?: string): Promise<CharacterAtlas | null> {
    const characters = new Map<CharacterId, LoadedCharacter>();

    await Promise.all(
      CHARACTER_IDS.map(async (id) => {
        try {
          const [meta, sheet] = await Promise.all([
            fetch(characterMetaUrl(id, assetRoot)).then((response) => response.json() as Promise<CharacterSpriteMeta>),
            Assets.load<Texture>(characterSheetUrl(id, assetRoot)),
          ]);
          // Guide section 9: nearest-neighbour only. Any filtering turns 32x32 pixel art into mush
          // the moment it is drawn at an integer multiple.
          sheet.source.scaleMode = 'nearest';
          characters.set(id, { meta, sheet });
        } catch {
          // Swallowed per character: three usable characters beat none, and the scene already
          // falls back to the procedural figure for anything missing.
        }
      }),
    );

    return characters.size > 0 ? new CharacterAtlas(characters) : null;
  }

  has(id: CharacterId): boolean {
    return this.characters.has(id);
  }

  /**
   * The sub-texture for one frame, cached. `null` for a character or animation the pack does not
   * carry, so a caller can fall back rather than draw a wrong rectangle off the sheet.
   */
  frameTexture(id: CharacterId, animation: SpriteAnimationName, frame: number): Texture | null {
    const character = this.characters.get(id);
    if (!character || !character.meta.animations[animation]) return null;

    const key = `${id}:${animation}:${frame}`;
    const cached = this.frameCache.get(key);
    if (cached) return cached;

    const rect = computeSpriteFrameRect(character.meta, animation, frame);
    const texture = new Texture({
      source: character.sheet.source,
      frame: new Rectangle(rect.x, rect.y, rect.width, rect.height),
    });
    this.frameCache.set(key, texture);
    return texture;
  }

  /** Frame index for this clip at `now`, read from the pack's own declared fps/loop. */
  frameIndexAt(id: CharacterId, animation: SpriteAnimationName, now: number): number {
    const clip = this.characters.get(id)?.meta.animations[animation];
    return clip ? selectSpriteFrame(clip, now) : 0;
  }
}

export interface SpriteCharacterInput {
  projectPath?: string;
  role: AgentRole;
  state: CharacterAnimationState;
  /** True only while dwelling at the archive cabinet — selects the celebration clip. */
  atArchive: boolean;
  facing: CharacterFacing;
  now: number;
}

/**
 * Where the two anchor lines sit, in the coordinates of the container this character is added to.
 * A desk-bearing clip pins its built-in table line to `deskSurfaceY`; a desk-free clip stands its
 * feet on `floorY` (see `resolveSpriteAnchor`).
 */
export interface SpriteCharacterPlacement {
  deskSurfaceY: number;
  floorY: number;
}

/**
 * Builds one character as a positioned `Container`, or `null` when the atlas cannot serve this
 * character (the caller then draws the procedural figure).
 *
 * Horizontal centring is on the frame itself: scanning the shipped PNGs puts every character's
 * body centre within half a pixel of the 32px frame's own centre, in every clip, so no per-clip
 * offset table is needed.
 */
export function renderSpriteCharacter(
  atlas: CharacterAtlas,
  input: SpriteCharacterInput,
  placement: SpriteCharacterPlacement,
): Container | null {
  const id = resolveCharacterId(input.projectPath);
  if (!atlas.has(id)) return null;

  const animation = selectSpriteAnimation({ state: input.state, atArchive: input.atArchive });
  const texture = atlas.frameTexture(id, animation, atlas.frameIndexAt(id, animation, input.now));
  if (!texture) return null;

  const scale = ROLE_SPRITE_SCALE[input.role];
  const anchor = resolveSpriteAnchor(animation);

  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5, 0);
  // Guide section 15: mirror rather than ship a second set of assets. The pack draws its
  // characters facing the viewer, so this reads as a flip of the walk cycle rather than a true
  // side-on turn — enough to tell an outbound leg from an inbound one.
  sprite.scale.set(input.facing === 'left' ? -scale : scale, scale);
  // Pins the anchor ROW of the frame onto the container's own origin (y = 0).
  sprite.y = -anchor.row * scale;

  const group = new Container();
  group.y = anchor.reference === 'desk-surface' ? placement.deskSurfaceY : placement.floorY;
  group.addChild(sprite);

  if (input.state === 'idle' && !input.atArchive) group.alpha = IDLE_CHARACTER_ALPHA;

  return group;
}
