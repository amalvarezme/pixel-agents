/**
 * Pure office layout math: which worker sits at which workstation, in the coordinates of the
 * drawn room (`scene/world/office-map.ts`). Canvas-free and deterministic — no PixiJS, no DOM.
 * This is the ONLY thing `ui/scene/pixi/` consults to decide where a character stands; PixiJS
 * never computes a position itself (design.md D3: "PixiJS v8 behind a pure-layout boundary").
 *
 * What replaced what: the office used to be a procedural 1920x1080 floor plan with a packed row
 * of up to eight generated desks and a second lane for child agents. The room is now a drawn
 * 1672x941 illustration with eleven real workstations in it, so there is nothing left to compute
 * — the desks exist in the artwork, and seating is the act of choosing which of them a worker
 * occupies (`docs/pixel-office/IMPLEMENTACION_AGENTE_CODIGO.md` section 8).
 *
 * The parent/child lane went with it. Lanes existed to group an orchestrator with its subagents
 * when desks were ours to place; a real room's desks are where the artist put them. Role survives
 * where it still reads — the orchestrator is drawn a whole step larger than its subagents — and
 * parentage survives in the hover tooltip.
 */
import { WORKSTATIONS, WORKSTATION_COUNT, type MapPoint } from '../world/office-map';

/** How many agents the office can seat at once; everything past this is overflow. */
export const MAX_SEATED_WORKERS = WORKSTATION_COUNT;

/**
 * The tightest horizontal gap between two workstations that share a row — measured from the map,
 * not chosen. `caption.ts` derives its caption width budget from it, so two neighbours' captions
 * cannot collide (G.2: "worker captions overlap horizontally").
 *
 * "Share a row" means their anchors are within one character-height of each other vertically:
 * captions only collide when they are drawn at the same height.
 */
const SAME_ROW_TOLERANCE = 60;

function computeMinSeatSpacing(): number {
  let min = Infinity;
  for (let i = 0; i < WORKSTATIONS.length; i++) {
    for (let j = i + 1; j < WORKSTATIONS.length; j++) {
      const a = WORKSTATIONS[i]!.interactionAnchor;
      const b = WORKSTATIONS[j]!.interactionAnchor;
      if (Math.abs(a.y - b.y) > SAME_ROW_TOLERANCE) continue;
      min = Math.min(min, Math.abs(a.x - b.x));
    }
  }
  return Number.isFinite(min) ? min : WORKSTATIONS.length;
}

export const MIN_SEAT_SPACING = computeMinSeatSpacing();

export interface LayoutWorkerInput {
  sessionKey: string;
}

export interface SeatLayout {
  sessionKey: string;
  /** The map's own id for the workstation this worker occupies (`ws_01`..`ws_11`). */
  stationId: string;
  /** Where the character STANDS: the station's `interactionAnchor`, on the floor in front of the
   * desk — never the laptop's own position (guide section 8). */
  x: number;
  y: number;
}

export interface OfficeLayout {
  seats: SeatLayout[];
  /** Workers beyond `MAX_SEATED_WORKERS` that got no workstation; the project roster panel
   * reports these by name, the floor only counts them. */
  overflowCount: number;
}

/**
 * Seats workers at workstations in the map's own `ws_01..ws_11` order, in the order the office
 * state lists them.
 *
 * Deliberately positional rather than hashed: two workers must never be assigned the same desk,
 * and a hash cannot promise that without a collision-resolution scheme whose result would be just
 * as arbitrary. The cost is that evicting a worker shifts everyone after it one desk along — the
 * packed row had exactly the same property, and a session ending is already a visible event.
 */
export function computeOfficeLayout(workers: LayoutWorkerInput[]): OfficeLayout {
  const seated = workers.slice(0, MAX_SEATED_WORKERS);

  return {
    seats: seated.map((worker, index) => {
      const station = WORKSTATIONS[index]!;
      return {
        sessionKey: worker.sessionKey,
        stationId: station.id,
        x: station.interactionAnchor.x,
        y: station.interactionAnchor.y,
      };
    }),
    overflowCount: Math.max(0, workers.length - MAX_SEATED_WORKERS),
  };
}

/** The seat a given worker holds, or `undefined` when it did not get one. */
export function findSeat(layout: OfficeLayout, sessionKey: string): MapPoint | undefined {
  const seat = layout.seats.find((candidate) => candidate.sessionKey === sessionKey);
  return seat ? { x: seat.x, y: seat.y } : undefined;
}
