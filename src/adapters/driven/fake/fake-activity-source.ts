/**
 * In-memory `ActivitySource` with zero I/O (tasks.md 5.1). Proves the port -> application ->
 * bus seam end to end without depending on any real harness adapter — those land in slices
 * 1b-3, one `ActivitySource` implementation each, per design.md D1.
 */
import type { AgentEvent, HarnessId } from '../../../domain/events/types';
import type {
  ActivitySource,
  ActivityStream,
  ActivityStreamItem,
  Checkpoint,
  SessionRef,
  SourceHealth,
} from '../../../ports/activity-source.port';

export interface FakeSessionScript {
  session: SessionRef;
  events: AgentEvent[];
}

export class FakeActivitySource implements ActivitySource {
  readonly harness: HarnessId;
  private readonly scripts: Map<string, FakeSessionScript>;
  private closed = false;

  constructor(harness: HarnessId, scripts: FakeSessionScript[]) {
    this.harness = harness;
    this.scripts = new Map(scripts.map((s) => [s.session.sessionKey, s]));
  }

  async probe(): Promise<SourceHealth> {
    return { status: 'ready' };
  }

  async *discover(): AsyncIterable<SessionRef> {
    for (const script of this.scripts.values()) {
      yield script.session;
    }
  }

  open(session: SessionRef, from: Checkpoint | null): ActivityStream {
    const script = this.scripts.get(session.sessionKey);
    const events = script?.events ?? [];
    const startIndex = from && from.kind === 'seq' ? (from.bySession[session.sessionKey] ?? 0) : 0;
    let stopped = false;

    const events$: AsyncIterable<ActivityStreamItem> = (async function* () {
      for (let i = startIndex; i < events.length; i++) {
        if (stopped) return;
        const nextEvent = events[i];
        if (!nextEvent) continue;
        const checkpoint: Checkpoint = { kind: 'seq', bySession: { [session.sessionKey]: i + 1 } };
        yield { event: nextEvent, checkpoint };
      }
    })();

    return {
      events: events$,
      stop(): void {
        stopped = true;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}
