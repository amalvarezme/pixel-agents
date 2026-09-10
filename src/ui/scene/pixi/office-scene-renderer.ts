/**
 * PixiJS v8 scene renderer (tasks.md 10.3). THE ONLY MODULE in this codebase allowed to import
 * `pixi.js` (design.md D3: "PixiJS v8 behind a pure-layout boundary"). Everything it draws comes
 * from an already-computed `OfficeFloorView` (pure layout math + atomic-design molecules) — this
 * file contains zero position/size/color decisions of its own.
 *
 * Draws desks, captions, the archive-trip document indicator + highlight (blocker B.2, tasks.md
 * 21.2), and the archive counter. Still no ticker of its own — `ui/scene/animation/
 * trip-animation.ts` already resolved every position/highlight decision into the `OfficeFloorView`
 * this module receives; this file only draws a static snapshot of it, once per call, exactly as
 * it did before slice 4.
 */
import { Container, Graphics, Text } from 'pixi.js';
import type { OfficeFloorView } from '../../components/organisms/office-floor';
import { ARCHIVE_DESTINATION } from '../layout/archive-path';
import { FLOOR_HEIGHT, FLOOR_WIDTH } from '../layout/office-layout';
import { selectCharacterAnimationState } from '../character/animation-state';
import { selectAnimationFrame } from '../character/animation-clock';
import { resolveModelAccentColor } from '../character/model-accent';
import { buildCharacterPose } from '../character/character-pose';
import { renderCharacter } from './character-renderer';

const CAPTION_OFFSET_Y = 24;
const CAPTION_STYLE = { fontSize: 14, fill: 0xffffff } as const;

const DOCUMENT_SIZE = 20;
const DOCUMENT_OFFSET_Y = 36;
const DOCUMENT_COLOR = 0xffffff;
const HIGHLIGHT_RING_COLOR = 0xffd166;
const BATCH_BADGE_STYLE = { fontSize: 12, fill: 0xffd166 } as const;

const ARCHIVE_COUNTER_OFFSET_Y = 90;
const ARCHIVE_COUNTER_STYLE = { fontSize: 16, fill: 0xffd166 } as const;

/** "readable, not busy" — a plain floor + a shallow back wall band + the fixed archive cabinet,
 * all derived from constants the layout math already exports. Zero position/decision logic of
 * its own, same as the rest of this file. */
const FLOOR_COLOR = 0x24242e;
const WALL_COLOR = 0x1a1a22;
const WALL_HEIGHT = 220;
const ARCHIVE_CABINET_SIZE = 100;
const ARCHIVE_CABINET_COLOR = 0x4a4a5c;

/** The character stands with its feet roughly at the desk's back edge, reading as "behind the
 * desk" rather than floating above it. */
const CHARACTER_DESK_OFFSET_Y_RATIO = 0.5;

/** Adds the carried-document sprite + optional highlight ring + optional ×N batch badge directly
 * onto `group` (the worker's own desk group, so they move with it) for a worker currently mid
 * archive-trip (blocker B.2: "a document indicator appears ... a brief highlight fires"). */
function addArchiveTripIndicator(group: Container, archiveTrip: { carryCount: number; highlight: boolean }, deskHeight: number): void {
  const documentY = -deskHeight / 2 - DOCUMENT_OFFSET_Y;

  const document = new Graphics()
    .rect(-DOCUMENT_SIZE / 2, -DOCUMENT_SIZE / 2, DOCUMENT_SIZE, DOCUMENT_SIZE)
    .fill(DOCUMENT_COLOR);
  document.y = documentY;
  group.addChild(document);

  if (archiveTrip.highlight) {
    const ring = new Graphics().circle(0, documentY, DOCUMENT_SIZE).stroke({ width: 3, color: HIGHLIGHT_RING_COLOR });
    group.addChild(ring);
  }

  if (archiveTrip.carryCount > 1) {
    const badge = new Text({ text: `×${archiveTrip.carryCount}`, style: BATCH_BADGE_STYLE });
    badge.anchor.set(0.5);
    badge.y = documentY;
    group.addChild(badge);
  }
}

/** True only while a worker's archive-trip is actively in transit (walking-out/walking-back) —
 * NOT while dwelling/highlighted at the cabinet, which reads as standing still. */
function isWorkerWalking(worker: { archiveTrip?: { highlight: boolean } }): boolean {
  return Boolean(worker.archiveTrip) && !worker.archiveTrip!.highlight;
}

/** Builds and draws the pixel-art character standing at `desk`, picking its animation
 * state/frame from data the scene already has (blocker/tasks.md: "idle/working/walking, driven
 * by data the scene already has") and its silhouette/accent from the worker's `agentProfile`
 * (blocker: "an orchestrator must look visibly different from a subagent ... the model should be
 * distinguishable at a glance"). */
function renderWorkerCharacter(
  worker: { activity?: 'working' | 'idle'; archiveTrip?: { highlight: boolean }; agentProfile?: { role: 'orchestrator' | 'subagent'; model?: string; requestedModel?: string } },
  deskHeight: number,
  now: number,
): Container {
  const animationState = selectCharacterAnimationState({ activity: worker.activity, isWalking: isWorkerWalking(worker) });
  const frame = selectAnimationFrame(animationState, now);
  const role = worker.agentProfile?.role ?? 'subagent';
  const accentColor = resolveModelAccentColor(worker.agentProfile?.model ?? worker.agentProfile?.requestedModel);

  const character = renderCharacter(buildCharacterPose({ role, state: animationState, frame, accentColor }));
  character.y = -deskHeight * CHARACTER_DESK_OFFSET_Y_RATIO;
  return character;
}

function renderDeskGroup(floor: OfficeFloorView, sessionKey: string, now: number): Container {
  const desk = floor.desks.find((d) => d.sessionKey === sessionKey);
  const worker = floor.workers.find((w) => w.sessionKey === sessionKey);
  const group = new Container();
  if (!desk || !worker) return group;

  group.x = worker.x;
  group.y = worker.y;

  const graphics = new Graphics()
    .rect(-desk.width / 2, -desk.height / 2, desk.width, desk.height)
    .fill(worker.badge.color);
  group.addChild(graphics);

  group.addChild(renderWorkerCharacter(worker, desk.height, now));

  const caption = new Text({ text: worker.caption, style: CAPTION_STYLE });
  caption.anchor.set(0.5, 0);
  caption.y = desk.height / 2 + CAPTION_OFFSET_Y;
  group.addChild(caption);

  if (worker.archiveTrip) {
    addArchiveTripIndicator(group, worker.archiveTrip, desk.height);
  }

  return group;
}

/** "An office background — floor, a back wall, desks the workers sit at, and the archive area" —
 * always exactly the same static elements, drawn once, behind every desk group. Zero
 * position/size/color decisions beyond the already-exported layout constants. */
function renderOfficeBackground(): Container {
  const group = new Container();

  const floor = new Graphics().rect(0, 0, FLOOR_WIDTH, FLOOR_HEIGHT).fill(FLOOR_COLOR);
  group.addChild(floor);

  const wall = new Graphics().rect(0, 0, FLOOR_WIDTH, WALL_HEIGHT).fill(WALL_COLOR);
  group.addChild(wall);

  const cabinet = new Graphics()
    .rect(
      ARCHIVE_DESTINATION.x - ARCHIVE_CABINET_SIZE / 2,
      ARCHIVE_DESTINATION.y - ARCHIVE_CABINET_SIZE / 2,
      ARCHIVE_CABINET_SIZE,
      ARCHIVE_CABINET_SIZE,
    )
    .fill(ARCHIVE_CABINET_COLOR);
  group.addChild(cabinet);

  return group;
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
 * position/highlight decision itself still comes from `OfficeFloorView`, exactly as before. */
export function renderOfficeScene(floor: OfficeFloorView, now: number = 0): Container {
  const scene = new Container();
  scene.addChild(renderOfficeBackground());
  for (const worker of floor.workers) {
    scene.addChild(renderDeskGroup(floor, worker.sessionKey, now));
  }
  scene.addChild(renderArchiveCounter(floor.archiveCount));
  return scene;
}
