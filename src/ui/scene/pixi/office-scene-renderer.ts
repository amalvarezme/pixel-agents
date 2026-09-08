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

const CAPTION_OFFSET_Y = 24;
const CAPTION_STYLE = { fontSize: 14, fill: 0xffffff } as const;

const DOCUMENT_SIZE = 20;
const DOCUMENT_OFFSET_Y = 36;
const DOCUMENT_COLOR = 0xffffff;
const HIGHLIGHT_RING_COLOR = 0xffd166;
const BATCH_BADGE_STYLE = { fontSize: 12, fill: 0xffd166 } as const;

const ARCHIVE_COUNTER_OFFSET_Y = 90;
const ARCHIVE_COUNTER_STYLE = { fontSize: 16, fill: 0xffd166 } as const;

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

function renderDeskGroup(floor: OfficeFloorView, sessionKey: string): Container {
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

  const caption = new Text({ text: worker.caption, style: CAPTION_STYLE });
  caption.anchor.set(0.5, 0);
  caption.y = desk.height / 2 + CAPTION_OFFSET_Y;
  group.addChild(caption);

  if (worker.archiveTrip) {
    addArchiveTripIndicator(group, worker.archiveTrip, desk.height);
  }

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

/** Builds a static PixiJS scene graph for the current office floor. No ticker, no tweening. */
export function renderOfficeScene(floor: OfficeFloorView): Container {
  const scene = new Container();
  for (const worker of floor.workers) {
    scene.addChild(renderDeskGroup(floor, worker.sessionKey));
  }
  scene.addChild(renderArchiveCounter(floor.archiveCount));
  return scene;
}
