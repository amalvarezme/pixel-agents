/**
 * `OfficeContainer` — the container half of the container/presentational split (tasks.md 10.4,
 * design.md: "Container-presentational"). Owns the SSE subscription and the client-side
 * projection of the normalized event stream into `OfficeState`; hands the presentational
 * `OfficeStage` only the resulting `OfficeViewModel`.
 *
 * The transport itself is injected as a `StreamConnectionFactory` rather than hard-coded to the
 * browser `EventSource` global, so this class is testable in Node without a browser (matching
 * every other port/adapter seam in this codebase) and so real wire-format decisions (SSE frame
 * parsing, reconnect/backoff) stay outside this projection logic.
 */
import type { AgentEvent, SessionLifecycle } from '../../domain/events/types';
import {
  applyEventToOfficeState,
  completeArchiveTripForWorker,
  createOfficeState,
  deserializeOfficeState,
  type OfficeSnapshotState,
  type OfficeState,
} from '../../domain/office/office';
import { buildOfficeViewModel } from '../state/office-view-model';
import type { OfficeStage } from '../scene/OfficeStage';
import { advanceTripAnimations, applyTripOverlay, createTripAnimatorState, type TripAnimatorState } from '../scene/animation/trip-animation';
import { advanceSofaVisits, applySofaOverlay, createSofaVisitState, type SofaVisitState } from '../scene/animation/sofa-visit';
import {
  advanceEndedWorkerDwells,
  applyEndedWorkerDwellOverlay,
  clearEndedWorkerDwell,
  createEndedWorkerDwellState,
  noteEndedWorker,
  type EndedWorkerDwellState,
} from '../scene/animation/ended-worker-dwell';
import type { LaunchResult, LaunchSpec } from '../../ports/session-launcher.port';

/**
 * G.1 fix: the wire shape is `OfficeSnapshotState` (domain/office/office.ts) plus `generatedAt` —
 * archive docking and in-flight carry queues, not just workers, so a late-connecting or evicted
 * client can reconstruct FULL office state, not merely the worker list.
 */
export interface OfficeSnapshotPayload extends OfficeSnapshotState {
  generatedAt: number;
}

export type StreamMessage =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'snapshot'; snapshot: OfficeSnapshotPayload }
  | { kind: 'snapshot_required' };

export interface StreamConnection {
  onMessage(handler: (message: StreamMessage) => void): void;
  close(): void;
}

export interface StreamConnectionFactory {
  connect(): StreamConnection;
}

/**
 * tasks.md 26.2: the launcher UI control is wired through `OfficeContainer`, mirroring the
 * `StreamConnection`/`StreamConnectionFactory` seam pattern above — the real implementation
 * (`adapters/driving/browser/fetch-launch-client.ts`'s `FetchLaunchClient`) is injected, never
 * imported here directly.
 */
export interface LaunchClient {
  requestLaunch(spec: LaunchSpec): Promise<LaunchResult>;
}

export class OfficeContainer {
  private officeState: OfficeState = createOfficeState();
  private connection: StreamConnection | null = null;

  /**
   * Archive-trip animation state (blocker B.2, tasks.md 21.2) and the animation clock's last
   * known instant. Deliberately separate from `officeState`/ingestion: `handleMessage` never
   * reads or advances either of these, so an arbitrarily fast burst of incoming events is never
   * slowed down by, or coupled to, animation playback (design.md: "ingestion never blocks").
   */
  private tripAnimatorState: TripAnimatorState = createTripAnimatorState();
  /** Sofa-visit animation state (a worker quiet for a minute walks to the meeting sofa and back).
   * Kept apart from `officeState`/ingestion for the exact same reason as `tripAnimatorState`
   * above: `handleMessage` never reads or advances it, so animation playback can never slow down
   * or couple to ingestion speed. */
  private sofaVisitState: SofaVisitState = createSofaVisitState();
  /**
   * Failed-worker dwell state (F1, spec: office-scene-renderer, "A failed subagent ends visibly,
   * not silently"). Kept apart from `officeState`/ingestion for the exact same reason as
   * `tripAnimatorState`/`sofaVisitState` above: `handleMessage` never ADVANCES it, so playback can
   * never slow down or couple to ingestion speed. `handleMessage` does, however, RECORD into it —
   * that is unavoidable, because the instant a worker leaves the floor (`session_end`) is the only
   * instant its last frame can still be captured; the clock that later expires the entry is still
   * `tick()`'s alone.
   */
  private endedWorkerDwellState: EndedWorkerDwellState = createEndedWorkerDwellState();
  private lastTickAt = 0;

  constructor(
    private readonly connectionFactory: StreamConnectionFactory,
    private readonly stage: OfficeStage,
    private readonly launchClient?: LaunchClient,
  ) {}

  /** tasks.md 26.2: pure delegation, mirroring `launchAgentSession`'s own delegation on the server side. */
  async requestLaunch(spec: LaunchSpec): Promise<LaunchResult> {
    if (!this.launchClient) throw new Error('OfficeContainer.requestLaunch: no LaunchClient was configured');
    return this.launchClient.requestLaunch(spec);
  }

  connect(): void {
    this.connection = this.connectionFactory.connect();
    this.connection.onMessage((message) => this.handleMessage(message));
  }

  disconnect(): void {
    this.connection?.close();
    this.connection = null;
  }

  /**
   * Advances the archive-trip and sofa-visit animations to `now` and re-renders. Called from the
   * browser's own `requestAnimationFrame` loop (`ui/main.ts`) — never from `handleMessage` — so
   * ingestion speed and animation playback speed can never affect each other.
   *
   * `now` MUST be WALL-CLOCK milliseconds, in the same domain as `AgentEvent.at` — not a raw
   * `requestAnimationFrame` timestamp, which counts from page load and would be roughly 1.8e12 ms
   * behind it. The archive trip never noticed the difference because it only ever compares `now`
   * against a `phaseStartedAt` it captured from that same `now`; the sofa visit is the first
   * animation to compare the render clock against a DOMAIN timestamp (`Worker.lastEventAt`), and
   * with a page-relative clock its "has this worker been quiet for a minute?" test read about
   * -1.8e12 ms and so was never true. `ui/main.ts` converts with `performance.timeOrigin`.
   */
  tick(now: number): void {
    this.lastTickAt = now;
    const structuralViewModel = buildOfficeViewModel(this.officeState);
    const { state, completed } = advanceTripAnimations(this.tripAnimatorState, structuralViewModel.workers, now);
    this.tripAnimatorState = state;
    for (const sessionKey of completed) {
      this.officeState = completeArchiveTripForWorker(this.officeState, sessionKey, now);
    }
    this.sofaVisitState = advanceSofaVisits(this.sofaVisitState, structuralViewModel.workers, now);
    this.endedWorkerDwellState = advanceEndedWorkerDwells(this.endedWorkerDwellState, now);
    this.render();
  }

  private handleMessage(message: StreamMessage): void {
    switch (message.kind) {
      case 'event': {
        const event = message.event;
        // Both dwell transitions are recorded BEFORE the fold, because the fold is what removes the
        // worker: the frame this captures is the last one that will ever exist for it.
        if (event.kind === 'session_end') {
          this.endedWorkerDwellState = this.recordWorkerEnd(event.sessionKey, event.lifecycle);
        } else if (event.kind === 'session_start') {
          // Rule 4: the coordinator re-admits an evicted session under the same key.
          this.endedWorkerDwellState = clearEndedWorkerDwell(this.endedWorkerDwellState, event.sessionKey);
        }
        this.officeState = applyEventToOfficeState(this.officeState, event);
        break;
      }
      case 'snapshot':
        // G.1: a snapshot rebuild must reconstruct archive docking + carry queues too, not just
        // discard them the way `{ ...createOfficeState(), workers: ... }` used to — otherwise a
        // late-connecting client shows every worker's document/archive-trip indicator as gone.
        this.officeState = deserializeOfficeState(message.snapshot);
        break;
      case 'snapshot_required':
        // Minimal slice-1b handling: drop the (possibly desynced) projection and wait for the
        // server's next `snapshot` frame on reconnect. Reconnect/backoff policy itself belongs
        // to the injected `StreamConnectionFactory`, not this projection layer.
        this.officeState = createOfficeState();
        break;
    }
    this.render();
  }

  /**
   * Captures `sessionKey`'s last rendered frame and hands it to the dwell module, which decides
   * whether it deserves a dwell at all (only a failure lifecycle does). The frame is captured HERE,
   * from the not-yet-folded state, because `session_end` is what deletes the worker from
   * `OfficeState`.
   *
   * The commit clock is `lastTickAt`, never `Date.now()` and never the event's own `at`: the dwell
   * is a playback duration measured by `render()`'s clock, and mixing the event clock in would let a
   * long-delayed `session_end` arrive already expired.
   */
  private recordWorkerEnd(sessionKey: string, lifecycle: SessionLifecycle | undefined): EndedWorkerDwellState {
    const captured = buildOfficeViewModel(this.officeState).workers.find((w) => w.sessionKey === sessionKey);
    if (!captured) return this.endedWorkerDwellState;
    // The ending event's own lifecycle, when it carries one, is the last word; when it carries none
    // (every real Pi `session_end`), the worker's last KNOWN lifecycle is — the preceding `status`
    // is what made the failure known in the first place.
    const endedWorker = lifecycle !== undefined ? { ...captured, lifecycle } : captured;
    return noteEndedWorker(this.endedWorkerDwellState, endedWorker, this.lastTickAt);
  }

  /**
   * Renders against `lastTickAt`, NEVER `Date.now()` — this is what actually decouples ingestion
   * from animation: `handleMessage` re-renders on every event, but always through whatever the
   * animation clock last was, so overlaying a trip's current position never advances time on its
   * own just because an event arrived.
   */
  private render(): void {
    const viewModel = buildOfficeViewModel(this.officeState);
    const withTripOverlay = applyTripOverlay(viewModel, this.tripAnimatorState, this.lastTickAt);
    const workers = applySofaOverlay(withTripOverlay.workers, this.sofaVisitState, this.lastTickAt);
    // Applied LAST, and it APPENDS rather than annotates: a dwelled worker is no longer in
    // `officeState`, so no earlier overlay could have drawn it.
    const withDwell = applyEndedWorkerDwellOverlay(workers, this.endedWorkerDwellState, this.lastTickAt);
    this.stage.update({ ...withTripOverlay, workers: withDwell });
  }
}
