/**
 * PixiJS v8 scene renderer (tasks.md 10.3). THE ONLY MODULE in this codebase allowed to import
 * `pixi.js` (design.md D3: "PixiJS v8 behind a pure-layout boundary"). Everything it draws comes
 * from an already-computed `OfficeFloorView` (pure layout math + atomic-design molecules) — this
 * file contains zero position/size/color decisions of its own.
 *
 * Minimal slice-1b scope: desks and a caption strip. NO animation — that lands in slice 4
 * (design.md: "Slicing").
 */
import { Container, Graphics, Text } from 'pixi.js';
import type { OfficeFloorView } from '../../components/organisms/office-floor';

const CAPTION_OFFSET_Y = 24;
const CAPTION_STYLE = { fontSize: 14, fill: 0xffffff } as const;

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

  return group;
}

/** Builds a static PixiJS scene graph for the current office floor. No ticker, no tweening. */
export function renderOfficeScene(floor: OfficeFloorView): Container {
  const scene = new Container();
  for (const worker of floor.workers) {
    scene.addChild(renderDeskGroup(floor, worker.sessionKey));
  }
  return scene;
}
