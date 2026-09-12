/**
 * Draws the exterior Sentinel through the office windows. Part of `ui/scene/pixi/`, the only
 * directory allowed to import `pixi.js` — where it IS and what it is DOING was already decided,
 * and unit-tested without a canvas, in `scene/world/sentinel-patrol.ts`.
 *
 * The window mask is the whole point (guide section 11: "Render only through window_mask.png").
 * The Sentinel walks in world coordinates that pass straight across the office wall, so without
 * the mask it would stroll through the room; with it, the only place it can ever appear is the
 * glass. Masking also means the renderer needs no separate notion of "outside" — the artwork
 * defines it.
 */
import { Assets, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import {
  selectSpriteFrame,
  sentinelMetaUrl,
  sentinelSheetUrl,
  type SentinelSpriteMeta,
} from '../character/character-sprite';
import { sentinelStateAt } from '../world/sentinel-patrol';

export class SentinelAsset {
  private readonly frameCache = new Map<string, Texture>();

  private constructor(
    private readonly meta: SentinelSpriteMeta,
    private readonly sheet: Texture,
  ) {}

  /** `null` when the asset cannot be loaded — the office then simply has no one outside its
   * windows, which is scenery missing, never information missing. */
  static async load(assetRoot?: string): Promise<SentinelAsset | null> {
    try {
      const [meta, sheet] = await Promise.all([
        fetch(sentinelMetaUrl(assetRoot)).then((response) => response.json() as Promise<SentinelSpriteMeta>),
        Assets.load<Texture>(sentinelSheetUrl(assetRoot)),
      ]);
      sheet.source.scaleMode = 'nearest';
      return new SentinelAsset(meta, sheet);
    } catch {
      return null;
    }
  }

  private frameTexture(action: string, frame: number): Texture | null {
    const clip = this.meta.animations[action];
    if (!clip) return null;

    const key = `${clip.row}:${frame}`;
    const cached = this.frameCache.get(key);
    if (cached) return cached;

    const texture = new Texture({
      source: this.sheet.source,
      frame: new Rectangle(
        frame * this.meta.frameWidth,
        clip.row * this.meta.frameHeight,
        this.meta.frameWidth,
        this.meta.frameHeight,
      ),
    });
    this.frameCache.set(key, texture);
    return texture;
  }

  /**
   * The Sentinel at clock reading `now`, already masked to the windows.
   *
   * Scale comes from the asset's own `defaultScale` rather than the room's depth bands: it is not
   * in the room, so the room's perspective does not describe it, and the pack chose a size that
   * reads correctly against the city outside.
   */
  render(now: number, windowMask: Texture): Container | null {
    const state = sentinelStateAt(now);
    const clip = this.meta.animations[state.action];
    if (!clip) return null;

    const texture = this.frameTexture(state.action, selectSpriteFrame(clip, state.elapsedMs));
    if (!texture) return null;

    const scale = this.meta.defaultScale;
    const sprite = new Sprite(texture);
    sprite.anchor.set(this.meta.origin.x / this.meta.frameWidth, this.meta.origin.y / this.meta.frameHeight);
    sprite.scale.set(state.mirrored ? -scale : scale, scale);
    sprite.x = state.x;
    sprite.y = state.y;

    const group = new Container();
    group.addChild(sprite);

    // The mask sprite has to live in the display list for PixiJS to render it, so it is added to
    // the very container it masks — standard practice, and it keeps the two impossible to separate.
    const mask = new Sprite(windowMask);
    group.addChild(mask);
    group.mask = mask;

    return group;
  }
}
