/**
 * Wires the pure `domain/sessions/session-lifecycle.ts` state machine into the live event bus
 * (design.md "Session discovery and aging out"), the same shape as
 * `adapters/driven/launcher/launch-correlation-coordinator.ts` wires `launch-correlator.ts`.
 *
 * Harness-agnostic and generic over every ingestion adapter: `observe` is meant to be called for
 * every event any `ActivitySource` publishes (via a thin `EventPublisher` wrapper in the
 * composition root), and `tick` is meant to be driven by a periodic timer using the same injected
 * `Clock` — never a real-time read of its own. A session that stops writing is aged out and, once
 * `EVICT_TIMEOUT_MS` elapses since its last event, evicted with the domain's own synthetic
 * `session_end(reason: 'timeout')` so the worker leaves the office floor.
 */
import { ageSession, recordActivity, startSession, type SessionLifecycleState } from '../../../domain/sessions/session-lifecycle';
import type { AgentEvent, HarnessId, SessionActivity } from '../../../domain/events/types';
import type { Clock } from '../../../ports/clock.port';
import type { EventPublisher } from '../../../ports/event-publisher.port';

function defaultAllocateId(): () => number {
  let next = 1;
  return () => next++;
}

interface TrackedSession {
  harness: HarnessId;
  state: SessionLifecycleState;
}

export class SessionLifecycleCoordinator {
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly allocateId: () => number;

  constructor(
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    allocateId?: () => number,
  ) {
    this.allocateId = allocateId ?? defaultAllocateId();
  }

  /**
   * Feeds one live event into lifecycle tracking. Publishes at most one `status` event, and only
   * when this event moves a session that had gone quiet back to work.
   *
   * Ages from the event's OWN `event.at`, never from `this.clock.now()` at the moment this method
   * runs: a transcript last written hours ago must age from that real timestamp, not from whenever
   * the server happened to ingest it (a JSONL bootstrap read at process start, or a delayed poll,
   * can observe an old event long after it actually happened).
   */
  observe(event: AgentEvent): void {
    if (event.kind === 'session_end') {
      this.sessions.delete(event.sessionKey);
      return;
    }
    if (event.kind === 'session_start') {
      this.sessions.set(event.sessionKey, { harness: event.harness, state: startSession(event.sessionKey, event.at) });
      return;
    }
    // A `parent` event is STRUCTURE (who launched whom, which model resolved), never evidence
    // that the session is still doing work — and it is synthesized, not read off a transcript, so
    // `claude-code/subagent-correlation-coordinator.ts` stamps every one of them with the CURRENT
    // wall clock. Aging from that timestamp restarted the eviction window at process start for
    // every historical session the discovery scan picked up, which is precisely how sessions
    // whose transcripts had not been touched for hours stayed on the office floor forever.
    if (event.kind === 'parent') return;
    const tracked = this.sessions.get(event.sessionKey);
    if (!tracked) return; // no session_start seen yet for this key — nothing to age
    const wasIdle = tracked.state.status === 'idle';
    tracked.state = recordActivity(tracked.state, event.at);
    if (wasIdle && tracked.state.status === 'active') this.publishActivity(tracked.harness, event.sessionKey, 'working', event.at);
  }

  /**
   * Ages every tracked session against the injected clock, publishing a synthetic `session_end` on
   * eviction and a `status(activity: 'idle')` the one time a session crosses the idle threshold.
   *
   * design.md "Session discovery and aging out" specifies idle as "worker dims, stays on stage" —
   * a UI behaviour the UI can only perform if something tells it. Before this announcement existed
   * nothing in the system ever set `Worker.activity` to anything but `'working'`, so every worker
   * on the floor was drawn as actively typing no matter how long ago it had last written a line.
   */
  tick(): void {
    const now = this.clock.now();
    for (const [sessionKey, tracked] of this.sessions) {
      const wasIdle = tracked.state.status === 'idle';
      const result = ageSession(tracked.state, now);
      tracked.state = result.state;
      if (!result.emittedEvent) {
        if (!wasIdle && tracked.state.status === 'idle') this.publishActivity(tracked.harness, sessionKey, 'idle', now);
        continue;
      }
      this.sessions.delete(sessionKey);
      this.publisher.publish({
        id: this.allocateId(),
        kind: 'session_end',
        harness: tracked.harness,
        sessionKey,
        at: result.emittedEvent.at,
        reason: result.emittedEvent.reason,
      });
    }
  }

  /** The one wire shape that carries idle/working into `domain/office/office.ts`'s projection. */
  private publishActivity(harness: HarnessId, sessionKey: string, activity: SessionActivity, at: number): void {
    this.publisher.publish({ id: this.allocateId(), kind: 'status', harness, sessionKey, at, activity });
  }
}
