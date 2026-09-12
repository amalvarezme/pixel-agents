/**
 * Turns the Pixel Office v2 character pack into PixiJS sprites. Part of `ui/scene/pixi/`, the only
 * directory allowed to import `pixi.js` (design.md D3) — every decision this file acts on was
 * already made, and unit-tested without a canvas, in `ui/scene/character/character-sprite.ts`.
 *
 * Two halves, the same split `pixi-office-renderer.ts` already uses:
 * - `CharacterAtlas.load` is the browser-only part: `Assets.load` over the character sheets plus a
 *   `fetch` of each metadata file. It cannot run under vitest (no fetch, no GPU), so it is verified
 *   by loading the page, exactly like `PixiOfficeRenderer.mount`.
 * - `renderSpriteCharacter` is pure scene-graph assembly on an already-loaded atlas. The scene
 *   calls it only when an atlas exists; with no atlas the office falls back to the procedural
 *   figure (`character-pose.ts`), so a failed or slow asset load degrades the art, never the app.
 *
 * Sub-frame textures are CACHED per (character, sheet row, frame). Without that, the per-frame
 * scene rebuild would allocate a fresh `Texture` for every worker 60 times a second.
 */
import { Assets, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { CharacterAnimationState } from '../character/animation-state';
import {
  CHARACTER_IDS,
  characterMetaUrl,
  characterSheetUrl,
  computeSpriteFrameRect,
  resolveCharacterId,
  resolveSpriteClip,
  selectSpriteFrame,
  selectSpritePose,
  spriteAnchorPoint,
  type CharacterDirection,
  type CharacterId,
  type CharacterSpriteMeta,
  type SpriteClipMeta,
} from '../character/character-sprite';

/**
 * Opacity of a worker whose session has gone quiet. design.md "Session discovery and aging out"
 * describes the idle state as "worker dims, stays on stage" — this is that dimming.
 *
 * Raised from the 0.55 that suited the old dark procedural office: against the v2 room's bright
 * white floor a 32px character at the back of the room all but disappeared at that value, and an
 * idle agent is still information. The idle POSE (turned away from the laptop) now carries most of
 * the signal, so the dimming only has to be noticeable, not drastic.
 */
export const IDLE_CHARACTER_ALPHA = 0.78;

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
          // Guide section 6: nearest-neighbour only. Any filtering turns 32x32 pixel art into mush
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

  meta(id: CharacterId): CharacterSpriteMeta | undefined {
    return this.characters.get(id)?.meta;
  }

  /**
   * The sub-texture for one frame of one clip, cached. Keyed by the clip's sheet ROW rather than
   * the action name it was resolved from: `walk`/`left` and `walk`/`right` are the same row read
   * the same way (the mirror is a sprite transform, not a different texture), so keying by action
   * would cache the identical rectangle twice.
   */
  frameTexture(id: CharacterId, clip: SpriteClipMeta, frame: number): Texture | null {
    const character = this.characters.get(id);
    if (!character) return null;

    const key = `${id}:${clip.row}:${frame}`;
    const cached = this.frameCache.get(key);
    if (cached) return cached;

    const rect = computeSpriteFrameRect(character.meta, clip, frame);
    const texture = new Texture({
      source: character.sheet.source,
      frame: new Rectangle(rect.x, rect.y, rect.width, rect.height),
    });
    this.frameCache.set(key, texture);
    return texture;
  }
}

export interface SpriteCharacterInput {
  projectPath?: string;
  state: CharacterAnimationState;
  /** True only while dwelling at the Persistent Memory Archive — selects the `point` clip. */
  atArchive: boolean;
  /** Which way the character is currently heading (`character-facing.ts`). */
  direction: CharacterDirection;
  now: number;
  /** The whole-number scale to draw at — perspective plus role, already resolved by
   * `resolveCharacterScale` so this renderer makes no sizing decision of its own. */
  scale: number;
}

/**
 * Builds one character as a `Container` whose ORIGIN IS ITS FEET, or `null` when the atlas cannot
 * serve this character (the caller then draws the procedural figure).
 *
 * Feet-origin is the whole point of the v2 contract (guide section 5): the caller positions the
 * container at a floor coordinate — a workstation's `interactionAnchor`, a point along a walk path
 * — and never has to know how tall the sprite is. The horizontal mirror for a left-facing
 * character is a negative x scale about that same anchor, so the feet stay exactly where the
 * caller put them.
 */
export function renderSpriteCharacter(atlas: CharacterAtlas, input: SpriteCharacterInput): Container | null {
  const id = resolveCharacterId(input.projectPath);
  const meta = atlas.meta(id);
  if (!meta) return null;

  const pose = selectSpritePose({ state: input.state, atArchive: input.atArchive, direction: input.direction });
  const resolved = resolveSpriteClip(meta, pose.action, pose.direction);
  if (!resolved) return null;

  const texture = atlas.frameTexture(id, resolved.clip, selectSpriteFrame(resolved.clip, input.now));
  if (!texture) return null;

  const anchor = spriteAnchorPoint(meta);

  const sprite = new Sprite(texture);
  sprite.anchor.set(anchor.x, anchor.y);
  // Guide section 5: mirror rather than ship a second set of assets for `left`.
  sprite.scale.set(resolved.mirror ? -input.scale : input.scale, input.scale);

  const group = new Container();
  group.addChild(sprite);
  if (input.state === 'idle' && !input.atArchive) group.alpha = IDLE_CHARACTER_ALPHA;

  return group;
}
