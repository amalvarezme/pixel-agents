/**
 * Real `StreamConnection`/`StreamConnectionFactory` backed by the browser's native `EventSource`
 * (browser-entrypoint work unit). Wires the wire-level SSE protocol (`stream.ts`: a bare
 * `message` frame carrying one `AgentEvent`, a named `snapshot` frame, a named
 * `snapshot_required` desync signal) into `OfficeContainer`'s `StreamMessage` union, and owns:
 *
 * - **`Last-Event-ID` resume.** The browser's native automatic retry sends that header itself,
 *   but a MANUALLY re-created `EventSource` (this class's own backoff-controlled reconnect,
 *   below) cannot set it — there is no headers option on the constructor. So this adapter tracks
 *   the last delivered frame's id itself and appends it as `?lastEventId=` on manual reconnects;
 *   `stream.ts`'s `parseLastEventId` accepts either.
 * - **Reconnect backoff on repeated failure**, 1s -> 30s with full jitter (design.md D2), fully
 *   under this adapter's own control rather than the browser's fixed-interval native retry — this
 *   class always closes and replaces the `EventSource` itself on error, so the native retry never
 *   gets a chance to race it.
 * - **`snapshot_required` handling.** Forwards the signal to the caller (which drops its stale
 *   projection, `OfficeContainer.handleMessage`) AND forces an immediate reconnect with the
 *   tracked id dropped, since `stream.ts`'s `planReplay` only returns a fresh `snapshot` frame for
 *   a connection with no `Last-Event-ID` at all.
 *
 * `EventSourceLike`/`EventSourceFactory` are the injection seam that makes this testable against
 * a fake in Node — the real factory (`window.EventSource`) is wired only in `ui/main.ts`.
 */
import type { AgentEvent } from '../../../domain/events/types';
import type { OfficeSnapshotPayload, StreamConnection, StreamConnectionFactory, StreamMessage } from '../../../ui/containers/OfficeContainer';

export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: { data: string; lastEventId: string }) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface EventSourceStreamOptions {
  createEventSource: EventSourceFactory;
  baseUrl: string;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable source of randomness for deterministic jitter in tests. Defaults to `Math.random`. */
  random?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

const DEFAULT_MIN_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30000;

export class EventSourceStreamConnection implements StreamConnection, StreamConnectionFactory {
  private readonly createEventSource: EventSourceFactory;
  private readonly baseUrl: string;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;

  private source: EventSourceLike | null = null;
  private handler: ((message: StreamMessage) => void) | null = null;
  private lastEventId: string | null = null;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: EventSourceStreamOptions) {
    this.createEventSource = options.createEventSource;
    this.baseUrl = options.baseUrl;
    this.minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.random = options.random ?? Math.random;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.backoffMs = this.minBackoffMs;
  }

  connect(): StreamConnection {
    this.closed = false;
    this.open();
    return this;
  }

  onMessage(handler: (message: StreamMessage) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      this.cancelTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.source?.close();
    this.source = null;
  }

  private buildUrl(): string {
    if (this.lastEventId === null) return this.baseUrl;
    const separator = this.baseUrl.includes('?') ? '&' : '?';
    return `${this.baseUrl}${separator}lastEventId=${encodeURIComponent(this.lastEventId)}`;
  }

  private open(): void {
    const source = this.createEventSource(this.buildUrl());
    this.source = source;

    source.onopen = () => {
      this.backoffMs = this.minBackoffMs;
    };

    source.addEventListener('message', (event) => {
      this.lastEventId = event.lastEventId || this.lastEventId;
      const agentEvent = JSON.parse(event.data) as AgentEvent;
      this.handler?.({ kind: 'event', event: agentEvent });
    });

    source.addEventListener('snapshot', (event) => {
      const snapshot = JSON.parse(event.data) as OfficeSnapshotPayload;
      this.handler?.({ kind: 'snapshot', snapshot });
    });

    source.addEventListener('snapshot_required', () => {
      this.handler?.({ kind: 'snapshot_required' });
      this.lastEventId = null;
      this.scheduleReconnect();
    });

    source.onerror = () => {
      this.scheduleReconnect();
    };
  }

  /** Full jitter (AWS backoff pattern): the delay is uniformly random within `[0, backoffMs]`,
   * and `backoffMs` itself doubles (capped at `maxBackoffMs`) after each scheduled attempt. */
  private scheduleReconnect(): void {
    if (this.closed) return;
    this.source?.close();
    this.source = null;

    const delay = this.random() * this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);

    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
