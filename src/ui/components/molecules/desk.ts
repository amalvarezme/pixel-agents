/**
 * Desk molecule (tasks.md 10.5): the furniture drawn under a worker sprite. Independent of
 * `worker.ts` because a desk exists whether or not the office currently has occupancy detail
 * (e.g. future archive/queue slots reuse the same furniture concept — design.md).
 */
import type { DeskLayout } from '../../scene/layout/office-layout';

export const ROOT_DESK_SIZE = 160;
export const SINGLE_AGENT_DESK_SIZE = 240;
export const CHILD_DESK_SIZE = 120;

export interface DeskView {
  sessionKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeskViewContext {
  totalWorkerCount: number;
}

function sizeForDesk(desk: DeskLayout, ctx: DeskViewContext): number {
  if (ctx.totalWorkerCount === 1) return SINGLE_AGENT_DESK_SIZE;
  return desk.lane === 'child' ? CHILD_DESK_SIZE : ROOT_DESK_SIZE;
}

export function buildDeskView(desk: DeskLayout, ctx: DeskViewContext): DeskView {
  const size = sizeForDesk(desk, ctx);
  return { sessionKey: desk.sessionKey, x: desk.x, y: desk.y, width: size, height: size };
}
