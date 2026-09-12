/**
 * PixiJS v8 scene renderer (tasks.md 10.3). THE ONLY MODULE in this codebase allowed to import
 * `pixi.js` (design.md D3: "PixiJS v8 behind a pure-layout boundary"). Everything it draws comes
 * from an already-computed `OfficeFloorView` (pure layout math + atomic-design molecules) — this
 * file contains zero position/size/color decisions of its own.
 *
 * Draws desks, characters (the Pixel Office sprite pack when an atlas is loaded, the procedural
 * figure otherwise), captions, the archive-trip document indicator + highlight (blocker B.2,
 * tasks.md 21.2), and the archive counter. Still no ticker of its own — `ui/scene/animation/
 * trip-animation.ts` already resolved every position/highlight decision into the `OfficeFloorView`
 * this module receives; this file only draws a static snapshot of it, once per call, exactly as
 * it did before slice 4.
 */
import { Container, Graphics, Text } from 'pixi.js';
import type { OfficeFloorView } from '../../components/organisms/office-floor';
import { ARCHIVE_DESTINATION } from '../layout/archive-path';
import { selectCharacterAnimationState } from '../character/animation-state';
import { selectAnimationFrame } from '../character/animation-clock';
import { resolveModelAccentColor } from '../character/model-accent';
import { resolveProjectCharacterColor } from '../character/project-accent';
import { buildCharacterPose } from '../character/character-pose';
import { buildDeskProps, buildOfficeScenery } from '../scenery/office-scenery';
import { renderCharacter } from './character-renderer';
import { renderSceneryLayers, renderSceneryShapes } from './scenery-renderer';
import { IDLE_CHARACTER_ALPHA, renderSpriteCharacter, type CharacterAtlas } from './sprite-character-renderer';
import type { CharacterDirection } from '../character/character-sprite';

const CAPTION_OFFSET_Y = 24;
const CAPTION_STYLE = { fontSize: 14, fill: 0xffffff } as const;

const DOCUMENT_SIZE = 20;
const DOCUMENT_OFFSET_Y = 36;
const DOCUMENT_COLOR = 0xffffff;
const HIGHLIGHT_RING_COLOR = 0xffd166;
const BATCH_BADGE_STYLE = { fontSize: 12, fill: 0xffd166 } as const;

const ARCHIVE_COUNTER_OFFSET_Y = 90;
const ARCHIVE_COUNTER_STYLE = { fontSize: 16, fill: 0xffd166 } as const;

/**
 * Defect fix: filling the whole desk with the fully-saturated harness colour made a 160-unit
 * block "the loudest thing on screen", pulling focus away from the character. The bulk of the
 * desk is now a fixed, muted surface; only a thin strip along its front edge still carries the
 * harness colour, so harness identity survives without dominating the frame.
 */
const DESK_SURFACE_COLOR = 0x4a4038;
const DESK_ACCENT_HEIGHT_RATIO = 0.3;

/** Defect fix: the character used to stand exactly ON the desk's back edge (`-height/2`), which
 * read as "perched on top" once the desk was a tall square. A fixed clearance keeps the figure's
 * feet strictly BEHIND that edge, so the desktop reads as furniture in front of it, not a
 * platform under it — independent of how tall any given desk is. */
const CHARACTER_DESK_CLEARANCE = 6;

/** Adds the carried-document sprite + optional highlight ring + optional ×N batch badge directly
 * onto `group` (the worker's own desk group, so they move with it) for a worker currently mid
 * archive-trip (blocker B.2: "a document indicator appears ... a brief highlight fires"). */
function addArchiveTripIndicator(
  group: Container,
  archiveTrip: { carryCount: number; highlight: boolean },
  deskHeight: number,
  carriedOffset: { x: number; y: number },
): void {
  // Offset by however far the character has walked: the document is in ITS hands, not left behind
  // hovering over an empty desk.
  const documentX = carriedOffset.x;
  const documentY = carriedOffset.y - deskHeight / 2 - DOCUMENT_OFFSET_Y;

  const document = new Graphics()
    .rect(-DOCUMENT_SIZE / 2, -DOCUMENT_SIZE / 2, DOCUMENT_SIZE, DOCUMENT_SIZE)
    .fill(DOCUMENT_COLOR);
  document.x = documentX;
  document.y = documentY;
  group.addChild(document);

  if (archiveTrip.highlight) {
    const ring = new Graphics().circle(documentX, documentY, DOCUMENT_SIZE).stroke({ width: 3, color: HIGHLIGHT_RING_COLOR });
    group.addChild(ring);
  }

  if (archiveTrip.carryCount > 1) {
    const badge = new Text({ text: `×${archiveTrip.carryCount}`, style: BATCH_BADGE_STYLE });
    badge.anchor.set(0.5);
    badge.x = documentX;
    badge.y = documentY;
    group.addChild(badge);
  }
}

/** True only while a worker's archive-trip is actively in transit (walking-out/walking-back) —
 * NOT while dwelling/highlighted at the cabinet, which reads as standing still. */
function isWorkerWalking(worker: { archiveTrip?: { highlight: boolean } }): boolean {
  return Boolean(worker.archiveTrip) && !worker.archiveTrip!.highlight;
}

interface RenderableWorker {
  activity?: 'working' | 'idle';
  archiveTrip?: { highlight: boolean; direction?: CharacterDirection };
  agentProfile?: { role: 'orchestrator' | 'subagent'; model?: string; requestedModel?: string };
  projectPath?: string;
}

/**
 * Builds the character for one worker, preferring the Pixel Office sprite pack and falling back to
 * the procedural figure when no atlas is loaded.
 *
 * Either way the same data decides everything: the animation comes from the worker's `activity`
 * and its archive trip, the SIZE from `agentProfile.role` (an orchestrator is drawn larger than
 * its subagents, same character), the IDENTITY from `projectPath` (every worker under one project
 * is the same character — `resolveCharacterId`, matching the procedural path's shared body colour),
 * and the direction from the active trip leg (`character-facing.ts`).
 */
function renderWorkerCharacter(
  worker: RenderableWorker,
  deskHeight: number,
  now: number,
  atlas?: CharacterAtlas,
): Container {
  const animationState = selectCharacterAnimationState({ activity: worker.activity, isWalking: isWorkerWalking(worker) });
  const role = worker.agentProfile?.role ?? 'subagent';
  const direction = worker.archiveTrip?.direction ?? 'down';
  const atArchive = Boolean(worker.archiveTrip?.highlight);

  if (atlas) {
    const sprite = renderSpriteCharacter(atlas, {
      projectPath: worker.projectPath,
      role,
      state: animationState,
      atArchive,
      direction,
      now,
    });
    if (sprite) {
      // v2 sprites are body-only and stand on their feet, so the figure goes where any person
      // would: on the floor just behind the desk's back edge, with the desk drawn in front of it.
      sprite.y = -(deskHeight / 2 + CHARACTER_DESK_CLEARANCE);
      return sprite;
    }
  }

  // Procedural fallback (`character-pose.ts`): drawn whenever the sprite pack is unavailable, and
  // the only path any Node test ever takes, since loading real textures needs a browser.
  const frame = selectAnimationFrame(animationState, now);
  const accentColor = resolveModelAccentColor(worker.agentProfile?.model ?? worker.agentProfile?.requestedModel);
  const bodyColor = resolveProjectCharacterColor(worker.projectPath);

  const character = renderCharacter(
    // The procedural figure is drawn only two ways; the pack's four-way heading collapses onto it.
    buildCharacterPose({ role, state: animationState, frame, accentColor, bodyColor, facing: direction === 'left' ? 'left' : 'right' }),
  );
  character.y = -(deskHeight / 2 + CHARACTER_DESK_CLEARANCE);
  if (animationState === 'idle') character.alpha = IDLE_CHARACTER_ALPHA;
  return character;
}

/** The desk itself: a muted surface plus a thin harness-coloured accent strip along its front
 * (near) edge, added directly onto `group` — furniture that stays in the background, not a block
 * that competes with the character for attention. */
function addDeskFurniture(group: Container, desk: { width: number; height: number }, badgeColor: string): void {
  const surface = new Graphics().rect(-desk.width / 2, -desk.height / 2, desk.width, desk.height).fill(DESK_SURFACE_COLOR);
  group.addChild(surface);

  const accentHeight = desk.height * DESK_ACCENT_HEIGHT_RATIO;
  const accent = new Graphics()
    .rect(-desk.width / 2, desk.height / 2 - accentHeight, desk.width, accentHeight)
    .fill(badgeColor);
  group.addChild(accent);
}

/**
 * One worker's whole workstation: the desk (fixed at its layout position), the character (offset
 * within the group by however far an archive trip has carried it), the caption, and the carried
 * document.
 *
 * The group sits at the DESK's position, not the worker's. Anything that walks does so as a local
 * offset inside the group, which is what keeps the furniture still while its occupant crosses the
 * office — `office-floor.ts` supplies the two positions separately for exactly this reason.
 */
function renderDeskGroup(floor: OfficeFloorView, sessionKey: string, now: number, atlas?: CharacterAtlas): Container {
  const desk = floor.desks.find((d) => d.sessionKey === sessionKey);
  const worker = floor.workers.find((w) => w.sessionKey === sessionKey);
  const group = new Container();
  if (!desk || !worker) return group;

  group.x = desk.x;
  group.y = desk.y;

  const character = renderWorkerCharacter(worker, desk.height, now, atlas);
  character.x += worker.x - desk.x;
  character.y += worker.y - desk.y;

  // The desk goes down first, then the character standing behind it, then the desk's own props —
  // so the monitor occludes the figure the way a real workstation would. v2 sprites carry no
  // furniture of their own (guide section 5), so both paths draw the same office furniture.
  addDeskFurniture(group, desk, worker.badge.color);
  group.addChild(character);
  group.addChild(renderSceneryShapes(buildDeskProps(desk)));

  const caption = new Text({ text: worker.caption, style: CAPTION_STYLE });
  caption.anchor.set(0.5, 0);
  caption.y = desk.height / 2 + CAPTION_OFFSET_Y;
  group.addChild(caption);

  if (worker.archiveTrip) {
    addArchiveTripIndicator(group, worker.archiveTrip, desk.height, { x: worker.x - desk.x, y: worker.y - desk.y });
  }

  return group;
}

/** "An office background — floor, a back wall, desks the workers sit at, and the archive area" —
 * always exactly the same static elements, drawn once, behind every desk group. Zero
 * position/size/color decisions beyond the already-exported layout constants. */
export function renderOfficeBackground(): Container {
  return renderSceneryLayers(buildOfficeScenery());
}

/** The fixed cabinet's cumulative trip counter (blocker B.2: "a per-archive counter
 * increments"), positioned above the fixed `ARCHIVE_DESTINATION` regardless of any worker. */
function renderArchiveCounter(archiveCount: number): Container {
  const group = new Container();
  group.x = ARCHIVE_DESTINATION.x;
  group.y = ARCHIVE_DESTINATION.y - ARCHIVE_COUNTER_OFFSET_Y;

  const text = new Text({ text: `Archived: ${archiveCount}`, style: ARCHIVE_COUNTER_STYLE });
  text.anchor.set(0.5);
  group.addChild(text);

  return group;
}

/** Builds a static PixiJS scene graph for the current office floor. No ticker of its own — `now`
 * only selects which pre-computed animation FRAME to draw (idle bob / typing / walk cycle); every
 * position/highlight decision itself still comes from `OfficeFloorView`, exactly as before.
 *
 * `background` exists purely for performance. The scenery (`scene/scenery/office-scenery.ts`) is
 * STATIC — it takes no input and never changes — yet `updateStage` tears the whole scene graph
 * down and rebuilds it every animation frame. Rebuilding it inline costs 560 rect draw-ops per
 * frame (~33,600/second at 60fps) to redraw pixels identical to the previous frame's; the old flat
 * background was 3. A caller that renders repeatedly builds it ONCE and passes the same Container
 * back in every frame. Omitting it keeps the previous self-contained behaviour, which is what the
 * tests rely on so that two scenes built in one test each own a distinct background. */
export interface RenderOfficeSceneOptions {
  background?: Container;
  /** Loaded Pixel Office sprite pack. Absent in every Node test and until `mount`'s async load
   * resolves; the scene then draws the procedural figure instead. */
  atlas?: CharacterAtlas;
}

export function renderOfficeScene(
  floor: OfficeFloorView,
  now: number = 0,
  options: RenderOfficeSceneOptions = {},
): Container {
  const scene = new Container();
  scene.addChild(options.background ?? renderOfficeBackground());

  // Y-sorting (character pack guide section 18): a workstation lower on the floor plan draws in
  // front of one further back, so a character crossing the office passes behind the desks above it
  // and in front of the desks below. Sorted by the CHARACTER's current position, not the desk's,
  // because that is the thing that moves; desks never overlap each other (the layout packs them
  // into separate rows), so carrying a desk along in z-order changes nothing visible.
  const ordered = [...floor.workers].sort((a, b) => a.y - b.y);
  for (const worker of ordered) {
    scene.addChild(renderDeskGroup(floor, worker.sessionKey, now, options.atlas));
  }

  scene.addChild(renderArchiveCounter(floor.archiveCount));
  return scene;
}
