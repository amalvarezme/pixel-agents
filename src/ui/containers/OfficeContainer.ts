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
import { applyEventToOfficeState, createOfficeState, type OfficeState, type Worker } from '../../domain/office/office';
import { buildOfficeViewModel } from '../state/office-view-model';
import type { OfficeStage } from '../scene/OfficeStage';

export interface OfficeSnapshotPayload {
  generatedAt: number;
  workers: Worker[];
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

export class OfficeContainer {
  private officeState: OfficeState = createOfficeState();
  private connection: StreamConnection | null = null;

  constructor(
    private readonly connectionFactory: StreamConnectionFactory,
    private readonly stage: OfficeStage,
  ) {}

  connect(): void {
    this.connection = this.connectionFactory.connect();
    this.connection.onMessage((message) => this.handleMessage(message));
  }

  disconnect(): void {
    this.connection?.close();
    this.connection = null;
  }

  private handleMessage(message: StreamMessage): void {
    switch (message.kind) {
      case 'event':
        this.officeState = applyEventToOfficeState(this.officeState, message.event);
        break;
      case 'snapshot':
        this.officeState = { ...createOfficeState(), workers: new Map(message.snapshot.workers.map((w) => [w.sessionKey, w])) };
        break;
      case 'snapshot_required':
        // Minimal slice-1b handling: drop the (possibly desynced) projection and wait for the
        // server's next `snapshot` frame on reconnect. Reconnect/backoff policy itself belongs
        // to the injected `StreamConnectionFactory`, not this projection layer.
        this.officeState = createOfficeState();
        break;
    }
    this.stage.update(buildOfficeViewModel(this.officeState));
  }
}
