/**
 * Client-side office projection (tasks.md 10.4: "OfficeContainer owns the SSE subscription and
 * client projection"). Pure, canvas-free, reusable both by `OfficeContainer` (folding the live
 * SSE stream) and by `ui/scene/pixi/` renderer input.
 *
 * Combines the domain's structural projection (`applyEventToOfficeState`, `domain/office/office`)
 * with the pure layout math (`office-layout.ts`) into one renderable view model.
 */
import type { HarnessId } from '../../domain/events/types';
import type { AgentProfile } from '../../domain/agents/agent-profile';
import type { OfficeState, WorkerActivity } from '../../domain/office/office';
import { computeArchivePath, type ScenePoint } from '../scene/layout/archive-path';
import { computeOfficeLayout, type DeskLane, type LayoutWorkerInput } from '../scene/layout/office-layout';
import type { CharacterDirection } from '../scene/character/character-sprite';

/** memory_write archive-trip animation data (tasks.md 21.2-21.4). `path` is harness-agnostic —
 * it is computed from the worker's desk position alone, never from `harness`. */
export interface ArchiveTripView {
  path: ScenePoint[];
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
  /** Where the CHARACTER currently is. Equal to `deskX`/`deskY` at rest, but overwritten with the
   * animated position while an archive trip is in flight (`animation/trip-animation.ts`'s
   * `applyTripOverlay`). */
  x: number;
  y: number;
  /**
   * Where the worker's DESK is — its layout position, fixed for as long as the worker holds that
   * desk. Separate from `x`/`y` because furniture does not walk: building the desk from the
   * animated position sent the whole workstation across the office on every archive trip, with the
   * character standing on it the entire way. `applyTripOverlay` deliberately leaves these two
   * fields alone, which is what lets the character leave its desk behind.
   *
   * Optional only so a hand-built view model in a test never has to restate a position it already
   * gave as `x`/`y` (the same concession `activity` makes below); `buildOfficeViewModel` always
   * sets both, and `buildOfficeFloorView` falls back to `x`/`y` when they are absent.
   */
  deskX?: number;
  deskY?: number;
  lane: DeskLane;
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
  archiveTrip?: ArchiveTripView;
}

/**
 * One worker's identity WITHOUT any scene position — the full census the floor cannot show.
 *
 * `workers` below is capped at `MAX_PACKED_WORKERS` (8 desks) and everything past that is reduced
 * to `overflowCount`, so a consumer that only reads `workers` silently under-reports a busy
 * machine: with 17 live sessions it sees 8 and has no way to know. Anything reporting on WHO is
 * active — the project roster panel — reads this instead.
 */
export interface OfficeRosterEntry {
  sessionKey: string;
  harness: HarnessId;
  projectPath?: string;
  activity?: WorkerActivity;
  role?: AgentProfile['role'];
}

export interface OfficeViewModel {
  /** Only the workers that got one of the office's limited desks. */
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

/** Projects the current `OfficeState` into a renderable `OfficeViewModel`. Pure — no I/O. */
export function buildOfficeViewModel(state: OfficeState): OfficeViewModel {
  const workers = [...state.workers.values()];
  const layoutInputs: LayoutWorkerInput[] = workers.map((w) => ({
    sessionKey: w.sessionKey,
    parentSessionKey: w.parentSessionKey,
  }));
  const layout = computeOfficeLayout(layoutInputs);
  const deskBySessionKey = new Map(layout.desks.map((d) => [d.sessionKey, d]));

  const roster: OfficeRosterEntry[] = workers.map((w) => ({
    sessionKey: w.sessionKey,
    harness: w.harness,
    ...(w.projectPath !== undefined ? { projectPath: w.projectPath } : {}),
    activity: w.activity,
    ...(w.agentProfile?.role ? { role: w.agentProfile.role } : {}),
  }));

  const viewModelWorkers: WorkerViewModel[] = [];
  for (const worker of workers) {
    const desk = deskBySessionKey.get(worker.sessionKey);
    if (!desk) continue; // beyond MAX_PACKED_WORKERS — counted in overflowCount instead
    const held = state.carryQueues.get(worker.sessionKey)?.held;
    viewModelWorkers.push({
      sessionKey: worker.sessionKey,
      harness: worker.harness,
      label: worker.label,
      x: desk.x,
      y: desk.y,
      deskX: desk.x,
      deskY: desk.y,
      lane: desk.lane,
      activity: worker.activity,
      ...(worker.toolLabel !== undefined ? { toolLabel: worker.toolLabel, toolDetail: worker.toolDetail } : {}),
      ...(worker.agentProfile ? { agentProfile: worker.agentProfile } : {}),
      ...(worker.projectPath !== undefined ? { projectPath: worker.projectPath } : {}),
      ...(held ? { archiveTrip: { path: computeArchivePath({ x: desk.x, y: desk.y }), carryCount: held.count } } : {}),
    });
  }

  return { workers: viewModelWorkers, roster, overflowCount: layout.overflowCount };
}
