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
import type { AgentEvent } from '../../domain/events/types';
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
   * Advances the archive-trip animation to `now` and re-renders. Called from the browser's own
   * `requestAnimationFrame` loop (`ui/main.ts`) — never from `handleMessage` — so ingestion speed
   * and animation playback speed can never affect each other.
   */
  tick(now: number): void {
    this.lastTickAt = now;
    const structuralViewModel = buildOfficeViewModel(this.officeState);
    const { state, completed } = advanceTripAnimations(this.tripAnimatorState, structuralViewModel.workers, now);
    this.tripAnimatorState = state;
    for (const sessionKey of completed) {
      this.officeState = completeArchiveTripForWorker(this.officeState, sessionKey, now);
    }
    this.render();
  }

  private handleMessage(message: StreamMessage): void {
    switch (message.kind) {
      case 'event':
        this.officeState = applyEventToOfficeState(this.officeState, message.event);
        break;
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
   * Renders against `lastTickAt`, NEVER `Date.now()` — this is what actually decouples ingestion
   * from animation: `handleMessage` re-renders on every event, but always through whatever the
   * animation clock last was, so overlaying a trip's current position never advances time on its
   * own just because an event arrived.
   */
  private render(): void {
    const viewModel = buildOfficeViewModel(this.officeState);
    this.stage.update(applyTripOverlay(viewModel, this.tripAnimatorState, this.lastTickAt));
  }
}
