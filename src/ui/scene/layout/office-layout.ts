/**
 * Pure office layout math (tasks.md 10.1, design.md "The Office Scene": coordinate model).
 *
 * Fixed logical 1920x1080 floor plan in SCENE UNITS, canvas-free and deterministic — no PixiJS,
 * no DOM, no browser API. This is the ONLY thing `ui/scene/pixi/` consults to decide where to
 * draw a desk; PixiJS never computes a position itself (design.md D3: "PixiJS v8 behind a pure-
 * layout boundary").
 *
 * Scope for the minimal slice-1b scene: single-agent centered layout, a multi-agent packed row
 * of at most 8 desks with overflow reported (not scrolled — scrolling is a UI/pixi concern, not
 * layout math), and root/child lane separation driven by `parentSessionKey`
 * (office-scene-renderer spec: "Parent/Child Lane Layout"). Archive/path-waypoint layout for the
 * `memory_write` animation is out of scope here — it lands in slice 4 (design.md: "Slicing").
 */

export const FLOOR_WIDTH = 1920;
export const FLOOR_HEIGHT = 1080;
export const MAX_PACKED_WORKERS = 8;

/** Exported so `components/atoms/caption.ts` can derive a caption-width budget from the same
 * single source of truth (G.2: "worker captions overlap horizontally" — the fix keeps desk
 * positions stable and instead bounds caption width to this spacing). */
export const DESK_SPACING = 200;
const ROOT_LANE_Y = FLOOR_HEIGHT / 2;
const CHILD_LANE_OFFSET_Y = 220;

/**
 * Defect fix: the packed row shares the root lane's y with the archive cabinet (`office-scene-
 * renderer.ts`'s `ARCHIVE_DESTINATION = { x: 1720, y: 540 }`). Centering the row on the full
 * `FLOOR_WIDTH` let a full 8-desk row reach far enough right to overlap the cabinet and its
 * counter. Shifting the row's own centre left of the floor's centre reserves that space, so the
 * archive destination the carry animation walks to stays visible as its own thing regardless of
 * how many workers are packed into the row. Cannot import `ARCHIVE_DESTINATION` directly here —
 * `archive-path.ts` already imports FROM this module, so the reverse import would be circular.
 */
const PACKED_ROW_ARCHIVE_CLEARANCE = 160;
const PACKED_ROW_CENTER_X = FLOOR_WIDTH / 2 - PACKED_ROW_ARCHIVE_CLEARANCE;

export interface LayoutWorkerInput {
  sessionKey: string;
  parentSessionKey: string | null;
}

export type DeskLane = 'root' | 'child';

export interface DeskLayout {
  sessionKey: string;
  x: number;
  y: number;
  lane: DeskLane;
}

export interface OfficeLayout {
  desks: DeskLayout[];
  /** Workers beyond `MAX_PACKED_WORKERS` that did not get a desk slot; the UI presents these as an overflow-scroll affordance. */
  overflowCount: number;
}

function computeRowX(index: number, count: number): number {
  const totalWidth = (count - 1) * DESK_SPACING;
  const startX = PACKED_ROW_CENTER_X - totalWidth / 2;
  return startX + index * DESK_SPACING;
}

/** Single-agent layout: one centered desk, no lane subdivision (office-scene-renderer spec). */
function computeSingleAgentLayout(worker: LayoutWorkerInput): OfficeLayout {
  return {
    desks: [{ sessionKey: worker.sessionKey, x: FLOOR_WIDTH / 2, y: ROOT_LANE_Y, lane: 'root' }],
    overflowCount: 0,
  };
}

export function computeOfficeLayout(workers: LayoutWorkerInput[]): OfficeLayout {
  if (workers.length === 0) return { desks: [], overflowCount: 0 };
  if (workers.length === 1) return computeSingleAgentLayout(workers[0]!);

  const visible = workers.slice(0, MAX_PACKED_WORKERS);
  const overflowCount = Math.max(0, workers.length - MAX_PACKED_WORKERS);
  const visibleKeys = new Set(visible.map((w) => w.sessionKey));

  const desks: DeskLayout[] = visible.map((w, index) => {
    const isChildOfVisibleParent = w.parentSessionKey !== null && visibleKeys.has(w.parentSessionKey);
    const lane: DeskLane = isChildOfVisibleParent ? 'child' : 'root';
    return {
      sessionKey: w.sessionKey,
      x: computeRowX(index, visible.length),
      y: lane === 'child' ? ROOT_LANE_Y + CHILD_LANE_OFFSET_Y : ROOT_LANE_Y,
      lane,
    };
  });

  return { desks, overflowCount };
}
