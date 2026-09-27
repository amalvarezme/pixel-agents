/**
 * Client-side office projection (tasks.md 10.4: "OfficeContainer owns the SSE subscription and
 * client projection"). Pure, canvas-free, reusable both by `OfficeContainer` (folding the live
 * SSE stream) and by `ui/scene/pixi/` renderer input.
 *
 * Combines the domain's structural projection (`applyEventToOfficeState`, `domain/office/office`)
 * with the pure layout math (`office-layout.ts`) into one renderable view model.
 */
import type { HarnessId, SessionLifecycle } from '../../domain/events/types';
import type { AgentProfile } from '../../domain/agents/agent-profile';
import type { OfficeState, WorkerActivity } from '../../domain/office/office';
import { computeOfficeLayout, type LayoutWorkerInput } from '../scene/layout/office-layout';
import { PERSISTENT_MEMORY, WAITING_AREA, type MapPoint } from '../scene/world/office-map';
import { resolveLifecyclePresentation } from '../scene/character/lifecycle-presentation';
import { officeNavigation } from '../scene/world/office-navigation';
import type { CharacterDirection } from '../scene/character/character-sprite';

/** memory_write archive-trip animation data (tasks.md 21.2-21.4). `path` is harness-agnostic — it
 * is routed from the worker's own seat to the Persistent Memory Archive, never from `harness`. */
export interface ArchiveTripView {
  path: MapPoint[];
  /** ×N badge count — 1 for a single document, >1 once a batch (carry-queue.ts) is promoted. */
  carryCount: number;
  /** Set by the render half (`ui/scene/animation/trip-animation.ts`'s `applyTripOverlay`) while
   * the worker is dwelling at the archive cabinet (blocker B.2: "a brief highlight fires").
   * `undefined` from `buildOfficeViewModel` itself — this field is animation-clock state, not
   * something the structural projection can know. */
  highlight?: boolean;
  /** Set by the render half: true for the whole trip once animation playback has started. */
  showDocument?: boolean;
  /** Set by the render half (`applyTripOverlay`): which way the character is heading on the
   * CURRENT leg of the trip, in the sprite pack's four-way vocabulary
   * (`ui/scene/character/character-facing.ts`). `undefined` from `buildOfficeViewModel` itself,
   * exactly like `highlight`/`showDocument` above. */
  direction?: CharacterDirection;
}

export interface WorkerViewModel {
  sessionKey: string;
  harness: HarnessId;
  label: string;
  /** Where the CHARACTER currently stands — its FEET, in the map's image-pixel coordinates. Equal
   * to `seatX`/`seatY` at rest, but overwritten with the animated position while an archive trip
   * is in flight (`animation/trip-animation.ts`'s `applyTripOverlay`). */
  x: number;
  y: number;
  /**
   * The workstation this worker occupies: where it stands when it is not walking, and where it
   * walks back to. Separate from `x`/`y` because the seat is fixed while its occupant moves — the
   * archive trip overwrites the position but never the seat, which is what lets a character leave
   * its desk and find it again.
   *
   * Optional only so a hand-built view model in a test never has to restate a position it already
   * gave as `x`/`y` (the same concession `activity` makes below); `buildOfficeViewModel` always
   * sets both.
   */
  seatX?: number;
  seatY?: number;
  /** The map's id for that workstation (`ws_01`..`ws_11`), for debugging and hover copy. */
  stationId?: string;
  /** Normalized tool_start caption pair (design.md "Captions"), resolved upstream per-harness. */
  toolLabel?: string;
  toolDetail?: string;
  /** Agent profile tracking: what this worker IS, what MODEL it runs, and what TASK it was
   * given — carried straight through from `Worker.agentProfile`. */
  agentProfile?: AgentProfile;
  /** The associated project's working directory, carried straight through from
   * `Worker.projectPath` — `undefined` for a harness that reports none of it (Antigravity). */
  projectPath?: string;
  /** Carried straight through from `Worker.activity` — selects the drawn idle/working animation
   * state (`ui/scene/character/animation-state.ts`). Optional here (unlike the always-present
   * domain field) so a hand-built view model never needs to specify it; the render layer degrades
   * a missing value to idle rather than inventing "working". */
  activity?: WorkerActivity;
  /**
   * Carried straight through from `Worker.lifecycle` — what this worker's own harness scheduler
   * reported. `resolveLifecyclePresentation` (`ui/scene/character/lifecycle-presentation.ts`) turns
   * it into whether this worker is drawn at a desk, whether it may look busy, and which flag it
   * carries. `undefined` for a harness that reports no lifecycle, which renders exactly as it did
   * before lifecycle existed.
   */
  lifecycle?: SessionLifecycle;
  archiveTrip?: ArchiveTripView;
  /** Carried straight through from `Worker.lastToolStartAt` — the pixi renderer uses it
   * (`ui/scene/character/animation-state.ts`'s `isToolRecentlyStarted`) to pick the `typing` vs.
   * `work` clip. `undefined` for a worker with no recorded tool_start. */
  lastToolStartAt?: number;
  /** Carried straight through from `Worker.lastEventAt` — the sofa-visit feature
   * (`ui/scene/animation/sofa-visit.ts`) reads it to tell how long this worker has been quiet.
   * `undefined` for a worker the domain has never stamped one onto. */
  lastEventAt?: number;
  /** Set by the render half (`ui/scene/animation/sofa-visit.ts`'s `applySofaOverlay`) while the
   * worker is walking to or sitting at the meeting sofa. `undefined` from `buildOfficeViewModel`
   * itself, exactly like `archiveTrip.highlight`/`showDocument`/`direction` above — this is
   * animation-clock state, not something the structural projection can know. Never set alongside
   * `archiveTrip`: filing a document always takes precedence (`applySofaOverlay`'s own rule). */
  sofaVisit?: { seated: boolean; direction: CharacterDirection };
}

/**
 * One worker's identity WITHOUT any scene position — the full census the floor cannot show.
 *
 * `workers` below is capped at `MAX_SEATED_WORKERS` (the eleven workstations the room actually
 * has) and everything past that is reduced to `overflowCount`, so a consumer that only reads
 * `workers` silently under-reports a busy machine: with 17 live sessions it sees 11 and has no way
 * to know. Anything reporting on WHO is active — the project roster panel — reads this instead.
 */
export interface OfficeRosterEntry {
  sessionKey: string;
  harness: HarnessId;
  projectPath?: string;
  activity?: WorkerActivity;
  /** Carried straight through from `Worker.lifecycle`, so the roster can report a queued or failed
   * worker even when it is past `MAX_SEATED_WORKERS` and absent from `workers`. */
  lifecycle?: SessionLifecycle;
  role?: AgentProfile['role'];
}

export interface OfficeViewModel {
  /** Only the workers that got one of the office's eleven workstations. */
  workers: WorkerViewModel[];
  /** EVERY worker, desk or no desk — see `OfficeRosterEntry`. Optional only so a hand-built view
   * model in a test never has to restate its workers twice (the same concession `deskX`/`deskY`
   * make above); `buildOfficeViewModel` always sets it. */
  roster?: OfficeRosterEntry[];
  overflowCount: number;
  /** Cumulative count of trips that have reached the archive cabinet (blocker B.2: "a per-archive
   * counter increments"). Set by the render half's `applyTripOverlay`; `undefined`/`0` from
   * `buildOfficeViewModel` itself, which has no animation clock to count against. */
  archiveCount?: number;
  /** The animation clock's current time, set by the render half's `applyTripOverlay` — reused by
   * `ui/scene/pixi/office-scene-renderer.ts` to pick idle/working/walking animation FRAMES
   * (`ui/scene/character/animation-clock.ts`), not just the archive-trip walk position. Absent
   * from `buildOfficeViewModel` itself, which has no animation clock. */
  now?: number;
}

/**
 * A stable waiting spot for one session, chosen by hashing its key across `WAITING_AREA` so the
 * same worker stands in the same place on every frame — a spot picked by array index or arrival
 * order would make workers hop as siblings come and go. Falls back to the worker's own seat if the
 * map ever declares no waiting area at all, so a queued worker is never drawn at (0, 0).
 */
function waitingSpotFor(sessionKey: string, fallback: MapPoint): MapPoint {
  if (WAITING_AREA.length === 0) return fallback;
  let hash = 0;
  for (const char of sessionKey) hash = (hash * 31 + char.charCodeAt(0)) % useSafeModulus;
  return WAITING_AREA[hash % WAITING_AREA.length] ?? fallback;
}

/** Keeps the rolling hash inside the safe-integer range without needing BigInt. */
const useSafeModulus = 0x7fffffff;

/** Projects the current `OfficeState` into a renderable `OfficeViewModel`. Pure — no I/O. */
export function buildOfficeViewModel(state: OfficeState): OfficeViewModel {
  const workers = [...state.workers.values()];
  const layoutInputs: LayoutWorkerInput[] = workers.map((w) => ({ sessionKey: w.sessionKey }));
  const layout = computeOfficeLayout(layoutInputs);
  const seatBySessionKey = new Map(layout.seats.map((seat) => [seat.sessionKey, seat]));

  const roster: OfficeRosterEntry[] = workers.map((w) => ({
    sessionKey: w.sessionKey,
    harness: w.harness,
    ...(w.projectPath !== undefined ? { projectPath: w.projectPath } : {}),
    activity: w.activity,
    ...(w.lifecycle !== undefined ? { lifecycle: w.lifecycle } : {}),
    ...(w.agentProfile?.role ? { role: w.agentProfile.role } : {}),
  }));

  const viewModelWorkers: WorkerViewModel[] = [];
  for (const worker of workers) {
    const seat = seatBySessionKey.get(worker.sessionKey);
    if (!seat) continue; // beyond MAX_SEATED_WORKERS — counted in overflowCount instead
    const held = state.carryQueues.get(worker.sessionKey)?.held;
    // A worker with no desk yet stands in the waiting area instead (spec: "A queued subagent does
    // not appear to be working"). `seatX`/`seatY` still name the desk that IS its, so the renderer
    // can walk it over the moment its lifecycle says it started.
    const presentation = resolveLifecyclePresentation(worker.lifecycle);
    const stand = presentation.seated ? seat : waitingSpotFor(worker.sessionKey, seat);
    viewModelWorkers.push({
      sessionKey: worker.sessionKey,
      harness: worker.harness,
      label: worker.label,
      x: stand.x,
      y: stand.y,
      seatX: seat.x,
      seatY: seat.y,
      stationId: seat.stationId,
      activity: worker.activity,
      ...(worker.lifecycle !== undefined ? { lifecycle: worker.lifecycle } : {}),
      ...(worker.toolLabel !== undefined ? { toolLabel: worker.toolLabel, toolDetail: worker.toolDetail } : {}),
      ...(worker.agentProfile ? { agentProfile: worker.agentProfile } : {}),
      ...(worker.projectPath !== undefined ? { projectPath: worker.projectPath } : {}),
      ...(worker.lastToolStartAt !== undefined ? { lastToolStartAt: worker.lastToolStartAt } : {}),
      ...(worker.lastEventAt !== undefined ? { lastEventAt: worker.lastEventAt } : {}),
      // Routed around the furniture rather than straight at the cabinet (guide section 7): the
      // room between a desk and the archive wall is full of desks, a sofa and the memory core.
      ...(held
        ? {
            archiveTrip: {
              path: officeNavigation.findPath({ x: seat.x, y: seat.y }, PERSISTENT_MEMORY.anchor),
              carryCount: held.count,
            },
          }
        : {}),
    });
  }

  return { workers: viewModelWorkers, roster, overflowCount: layout.overflowCount };
}
