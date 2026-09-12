/**
 * PixiJS v8 scene renderer (tasks.md 10.3). One of only two modules allowed to import `pixi.js`
 * (design.md D3: "PixiJS v8 behind a pure-layout boundary"). Everything it draws comes from an
 * already-computed `OfficeFloorView` plus the shipped office map — this file contains zero
 * position/size/colour decisions of its own.
 *
 * Layer order is fixed by section 4 of `docs/pixel-office/IMPLEMENTACION_AGENTE_CODIGO.md` and is
 * the whole reason the room reads as a room:
 *
 *   1. `background.png`
 *   2. the exterior Sentinel, clipped by `window_mask.png`
 *   3. agents standing BEHIND furniture, sorted by the y of their FEET
 *   4. `foreground.png`
 *   5. agents standing IN FRONT of furniture, sorted the same way
 *   6. UI (captions, carried documents, the archive counter)
 *
 * Sorting by feet (section 12: "No ordenar por el centro del sprite ni por su esquina superior
 * izquierda") is what lets a character walking along the front of the room pass in front of the
 * desks behind it.
 *
 * The split around the foreground is what makes an agent SIT AT its workstation rather than hide
 * behind it. A workstation's anchor is the floor in front of the desk — that is what the anchor
 * means — so its occupant belongs on top of that desk's art, facing the laptop, with the desk
 * behind it. A character the furniture really does stand in front of goes under the layer instead.
 * `world/foreground-occlusion.ts` makes that call per character, from the map's own rectangles;
 * nothing here decides it.
 *
 * Still no ticker of its own — `ui/scene/animation/trip-animation.ts` has already resolved every
 * position and highlight into the `OfficeFloorView` this module receives; `now` only selects which
 * animation FRAME of an already-chosen clip to draw.
 */
import { Container, Graphics, Sprite, Text, type TextStyleOptions, type Texture } from 'pixi.js';
import type { OfficeFloorView } from '../../components/organisms/office-floor';
import type { WorkerView } from '../../components/molecules/worker';
import { PERSISTENT_MEMORY, WORLD_HEIGHT, WORLD_WIDTH } from '../world/office-map';
import { selectCharacterAnimationState } from '../character/animation-state';
import { selectAnimationFrame } from '../character/animation-clock';
import { resolveModelAccentColor } from '../character/model-accent';
import { resolveProjectCharacterColor } from '../character/project-accent';
import { buildCharacterPose } from '../character/character-pose';
import { CHARACTER_BODY_HEIGHT, type CharacterDirection } from '../character/character-sprite';
import { renderCharacter } from './character-renderer';
import { IDLE_CHARACTER_ALPHA, renderSpriteCharacter, type CharacterAtlas } from './sprite-character-renderer';

/**
 * Floor colour of the artwork, sampled from `background.png` itself. Drawn only when the image has
 * not loaded (or cannot): the office is bright, and a scene that fell back to the old dark slab
 * would render every caption and character against the wrong contrast for as long as the load
 * took.
 */
const FALLBACK_FLOOR_COLOR = 0xd6dfec;

/** Captions sit on a bright room, so they are dark on a light plate rather than light on dark. */
const CAPTION_STYLE = { fontSize: 13, fill: 0x1b2838, fontWeight: '600' } as const;
const CAPTION_PLATE_COLOR = 0xffffff;
const CAPTION_PLATE_ALPHA = 0.82;
const CAPTION_PLATE_PADDING_X = 5;
const CAPTION_PLATE_PADDING_Y = 1;
/** Gap between the top of a character's head and its caption plate. */
const CAPTION_GAP = 8;

const DOCUMENT_SIZE = 16;
/** How far above the head the carried document floats. */
const DOCUMENT_GAP = 30;
const DOCUMENT_COLOR = 0xffffff;
const DOCUMENT_BORDER_COLOR = 0x2f6fed;
const HIGHLIGHT_RING_COLOR = 0xf5a524;
const BATCH_BADGE_STYLE = { fontSize: 11, fill: 0x1b2838, fontWeight: '700' } as const;

const ARCHIVE_COUNTER_STYLE = { fontSize: 15, fill: 0xffffff, fontWeight: '700' } as const;
const ARCHIVE_COUNTER_PLATE_COLOR = 0x10203a;
const ARCHIVE_COUNTER_PLATE_ALPHA = 0.72;
/** The counter sits above the archive's own approach anchor, clear of the agent standing on it. */
const ARCHIVE_COUNTER_OFFSET_Y = 150;

/** True only while a worker's archive trip is actively in transit (walking out or back) — NOT
 * while dwelling at the archive, which reads as standing still. */
function isWorkerWalking(worker: Pick<WorkerView, 'archiveTrip'>): boolean {
  return Boolean(worker.archiveTrip) && !worker.archiveTrip!.highlight;
}

/**
 * Average glyph width as a fraction of font size, the same ~55% approximation `caption.ts` uses to
 * budget caption length. The plate is sized from it rather than from `Text.width`: reading a
 * PixiJS text's measured width forces a canvas-backed measurement, which does not exist in Node
 * and would make every scene test require a DOM.
 */
const AVG_GLYPH_WIDTH_RATIO = 0.55;

/** A text label on a translucent plate, so it stays readable over any part of the artwork. */
function renderPlatedLabel(
  text: string,
  style: TextStyleOptions & { fontSize: number },
  plate: { color: number; alpha: number },
): Container {
  const group = new Container();
  const label = new Text({ text, style });
  label.anchor.set(0.5);

  const width = text.length * style.fontSize * AVG_GLYPH_WIDTH_RATIO;
  const height = style.fontSize;

  const background = new Graphics()
    .roundRect(
      -width / 2 - CAPTION_PLATE_PADDING_X,
      -height / 2 - CAPTION_PLATE_PADDING_Y,
      width + CAPTION_PLATE_PADDING_X * 2,
      height + CAPTION_PLATE_PADDING_Y * 2,
      3,
    )
    .fill({ color: plate.color, alpha: plate.alpha });

  group.addChild(background, label);
  return group;
}

/**
 * Builds the character for one worker, preferring the Pixel Office sprite pack and falling back to
 * the procedural figure when no atlas is loaded. The returned container's origin is the
 * character's FEET either way, so the caller positions it on the floor and nothing else.
 *
 * The same data decides everything: the clip and the direction come from the worker's `activity`
 * and its archive trip, the SIZE from `WorkerView.scale` (the room's perspective plus the role
 * bonus, already resolved), and the IDENTITY from `projectPath` — every worker under one project
 * is the same character, matching the procedural path's shared body colour.
 */
function renderWorkerCharacter(worker: WorkerView, now: number, atlas?: CharacterAtlas): Container {
  const animationState = selectCharacterAnimationState({ activity: worker.activity, isWalking: isWorkerWalking(worker) });
  const direction: CharacterDirection = worker.archiveTrip?.direction ?? 'down';
  const atArchive = Boolean(worker.archiveTrip?.highlight);

  if (atlas) {
    const sprite = renderSpriteCharacter(atlas, {
      projectPath: worker.projectPath,
      state: animationState,
      atArchive,
      direction,
      now,
      scale: worker.scale,
    });
    if (sprite) return sprite;
  }

  // Procedural fallback (`character-pose.ts`): drawn whenever the sprite pack is unavailable, and
  // the only path any Node test ever takes, since loading real textures needs a browser.
  const frame = selectAnimationFrame(animationState, now);
  const accentColor = resolveModelAccentColor(worker.agentProfile?.model ?? worker.agentProfile?.requestedModel);
  const bodyColor = resolveProjectCharacterColor(worker.projectPath);

  const character = renderCharacter(
    buildCharacterPose({
      role: worker.agentProfile?.role ?? 'subagent',
      state: animationState,
      frame,
      accentColor,
      bodyColor,
      // The procedural figure is drawn only two ways; the pack's four-way heading collapses onto it.
      facing: direction === 'left' ? 'left' : 'right',
    }),
  );
  if (animationState === 'idle') character.alpha = IDLE_CHARACTER_ALPHA;
  return character;
}

/** The carried document, plus its arrival highlight and ×N batch badge, floating above the
 * character's head — in ITS hands, so it travels with it (blocker B.2). */
function addArchiveTripIndicator(group: Container, worker: WorkerView): void {
  const trip = worker.archiveTrip;
  if (!trip) return;

  const y = -CHARACTER_BODY_HEIGHT * worker.scale - DOCUMENT_GAP;

  const document = new Graphics()
    .rect(-DOCUMENT_SIZE / 2, -DOCUMENT_SIZE / 2, DOCUMENT_SIZE, DOCUMENT_SIZE)
    .fill(DOCUMENT_COLOR)
    .stroke({ width: 2, color: DOCUMENT_BORDER_COLOR });
  document.y = y;
  group.addChild(document);

  if (trip.highlight) {
    const ring = new Graphics().circle(0, y, DOCUMENT_SIZE).stroke({ width: 3, color: HIGHLIGHT_RING_COLOR });
    group.addChild(ring);
  }

  if (trip.carryCount > 1) {
    const badge = new Text({ text: `×${trip.carryCount}`, style: BATCH_BADGE_STYLE });
    badge.anchor.set(0.5);
    badge.y = y;
    group.addChild(badge);
  }
}

/**
 * One worker: the character standing on the floor, its caption above its head, and whatever it is
 * carrying. The whole group sits at the character's own position, which is what makes the archive
 * trip a matter of moving one container rather than offsetting everything inside it — the desk it
 * left behind belongs to the background artwork and never moves.
 */
function renderWorker(worker: WorkerView, now: number, atlas?: CharacterAtlas): Container {
  const group = new Container();
  group.x = worker.x;
  group.y = worker.y;

  group.addChild(renderWorkerCharacter(worker, now, atlas));

  const caption = renderPlatedLabel(worker.caption, CAPTION_STYLE, {
    color: CAPTION_PLATE_COLOR,
    alpha: CAPTION_PLATE_ALPHA,
  });
  caption.y = -CHARACTER_BODY_HEIGHT * worker.scale - CAPTION_GAP;
  group.addChild(caption);

  addArchiveTripIndicator(group, worker);
  return group;
}

/**
 * The room itself. `texture` is the shipped `background.png`; without it the scene paints the
 * artwork's own floor colour so the office is never an empty void while the image is in flight (or
 * in a Node test, which has no textures at all).
 */
export function renderOfficeBackground(texture?: Texture): Container {
  const group = new Container();
  if (texture) {
    group.addChild(new Sprite(texture));
    return group;
  }
  group.addChild(new Graphics().rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT).fill(FALLBACK_FLOOR_COLOR));
  return group;
}

/** The archive's cumulative trip counter (blocker B.2), pinned above the Persistent Memory
 * Archive's own approach anchor regardless of any worker. */
function renderArchiveCounter(archiveCount: number): Container {
  const counter = renderPlatedLabel(`Archived: ${archiveCount}`, ARCHIVE_COUNTER_STYLE, {
    color: ARCHIVE_COUNTER_PLATE_COLOR,
    alpha: ARCHIVE_COUNTER_PLATE_ALPHA,
  });
  counter.x = PERSISTENT_MEMORY.anchor.x;
  counter.y = PERSISTENT_MEMORY.anchor.y - ARCHIVE_COUNTER_OFFSET_Y;
  return counter;
}

/** The exterior Sentinel and the mask that confines it to the windows — supplied together,
 * because one without the other would put it inside the room (guide section 11). */
export interface SentinelLayer {
  asset: { render(now: number, windowMask: Texture): Container | null };
  windowMask: Texture;
}

export interface RenderOfficeSceneOptions {
  /**
   * The room's own artwork, loaded once by `pixi-office-renderer.ts`. Both layers are optional:
   * the scene degrades to a flat floor rather than failing, and no Node test can load a texture.
   *
   * `background` doubles as a performance contract — `updateStage` tears the whole scene graph
   * down and rebuilds it every animation frame, and a caller that renders repeatedly passes the
   * same container back in every frame instead of rebuilding it 60 times a second.
   */
  background?: Container;
  foreground?: Texture;
  /** Loaded Pixel Office sprite pack. Absent in every Node test and until `mount`'s async load
   * resolves; the scene then draws the procedural figure instead. */
  atlas?: CharacterAtlas;
  /** Absent until the Sentinel's own sheet and the window mask have both loaded. */
  sentinel?: SentinelLayer;
}

export function renderOfficeScene(
  floor: OfficeFloorView,
  now: number = 0,
  options: RenderOfficeSceneOptions = {},
): Container {
  const scene = new Container();
  scene.addChild(options.background ?? renderOfficeBackground());

  // Behind the agents and clipped to the glass: the Sentinel is OUTSIDE, and it never takes part
  // in anything the office does (guide section 11).
  if (options.sentinel) {
    const sentinel = options.sentinel.asset.render(now, options.sentinel.windowMask);
    if (sentinel) scene.addChild(sentinel);
  }

  // Guide section 12: sort by the FEET. A character lower in the room is nearer the viewer and
  // draws in front of everyone behind it.
  const ordered = [...floor.workers].sort((a, b) => a.y - b.y);

  for (const worker of ordered.filter((candidate) => candidate.behindForeground)) {
    scene.addChild(renderWorker(worker, now, options.atlas));
  }

  // Guide section 4: the foreground is what lets furniture occlude the people behind it — the
  // overlap that stops the characters looking pasted onto the picture.
  if (options.foreground) scene.addChild(new Sprite(options.foreground));

  // ...and everyone the furniture does NOT stand in front of goes on top of it, which is how an
  // agent at its own workstation reads as sitting at the desk rather than hiding behind it.
  for (const worker of ordered.filter((candidate) => !candidate.behindForeground)) {
    scene.addChild(renderWorker(worker, now, options.atlas));
  }

  scene.addChild(renderArchiveCounter(floor.archiveCount));
  return scene;
}
