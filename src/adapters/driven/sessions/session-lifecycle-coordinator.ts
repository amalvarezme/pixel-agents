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
import type { AgentEvent, HarnessId } from '../../../domain/events/types';
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

  /** Feeds one live event into lifecycle tracking. Never publishes anything itself. */
  observe(event: AgentEvent): void {
    if (event.kind === 'session_end') {
      this.sessions.delete(event.sessionKey);
      return;
    }
    if (event.kind === 'session_start') {
      this.sessions.set(event.sessionKey, { harness: event.harness, state: startSession(event.sessionKey, this.clock.now()) });
      return;
    }
    const tracked = this.sessions.get(event.sessionKey);
    if (!tracked) return; // no session_start seen yet for this key — nothing to age
    tracked.state = recordActivity(tracked.state, this.clock.now());
  }

  /** Ages every tracked session against the injected clock, publishing a synthetic session_end on eviction. */
  tick(): void {
    const now = this.clock.now();
    for (const [sessionKey, tracked] of this.sessions) {
      const result = ageSession(tracked.state, now);
      tracked.state = result.state;
      if (!result.emittedEvent) continue;
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
}
