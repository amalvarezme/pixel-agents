import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../domain/events/types';
import type { Clock } from '../../../ports/clock.port';
import { EVICT_TIMEOUT_MS, IDLE_TIMEOUT_MS } from '../../../domain/sessions/session-lifecycle';
import { SessionLifecycleCoordinator } from './session-lifecycle-coordinator';

interface FakeClock extends Clock {
  set(t: number): void;
}

function makeFakeClock(initial = 0): FakeClock {
  let current = initial;
  return {
    now: () => current,
    set: (t: number) => {
      current = t;
    },
  };
}

function sessionStart(sessionKey: string, harness: AgentEvent['harness'] = 'claude-code', at = 0): AgentEvent {
  return { id: 1, kind: 'session_start', harness, sessionKey, at };
}

function toolStart(sessionKey: string, harness: AgentEvent['harness'] = 'claude-code', at = 0): AgentEvent {
  return { id: 2, kind: 'tool_start', harness, sessionKey, at };
}

function makeCoordinator(): { coordinator: SessionLifecycleCoordinator; publish: ReturnType<typeof vi.fn>; clock: FakeClock } {
  const publish = vi.fn<(event: AgentEvent) => void>();
  const clock = makeFakeClock(0);
  const coordinator = new SessionLifecycleCoordinator(
    { publish },
    clock,
    (() => {
      let next = 1;
      return () => next++;
    })(),
  );
  return { coordinator, publish, clock };
}

describe('SessionLifecycleCoordinator eviction boundary', () => {
  it('does NOT emit a synthetic session_end just before EVICT_TIMEOUT_MS', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));

    clock.set(EVICT_TIMEOUT_MS - 1);
    coordinator.tick();

    // Asserted on KIND, not on silence: this far past the idle threshold the session has already
    // (correctly) announced itself idle. What must not have happened is the eviction.
    expect(publish.mock.calls.map((call) => call[0]?.kind)).not.toContain('session_end');
  });

  it('emits exactly one synthetic session_end(reason: timeout) for the RIGHT sessionKey/harness pair at EVICT_TIMEOUT_MS', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));

    clock.set(EVICT_TIMEOUT_MS);
    coordinator.tick();

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.kind).toBe('session_end');
    expect(event.sessionKey).toBe('claude-code:s1');
    expect(event.harness).toBe('claude-code');
    expect(event.reason).toBe('timeout');
  });

  it('does not evict an unrelated still-active session, and evicts only the timed-out one', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:old', 'claude-code'));

    clock.set(EVICT_TIMEOUT_MS - 1000);
    // Real activity at EVICT_TIMEOUT_MS - 1000 — only 1000ms old once we tick at EVICT_TIMEOUT_MS.
    coordinator.observe(sessionStart('codex:fresh', 'codex', EVICT_TIMEOUT_MS - 1000));

    clock.set(EVICT_TIMEOUT_MS);
    coordinator.tick();

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.sessionKey).toBe('claude-code:old');
    expect(event.harness).toBe('claude-code');
  });

  it('recordActivity resets the eviction window: a session active just before the deadline survives it', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));

    // Fresh activity just before the original deadline resets `lastEventAt`.
    clock.set(EVICT_TIMEOUT_MS - 1);
    coordinator.observe(toolStart('claude-code:s1', 'claude-code', EVICT_TIMEOUT_MS - 1));

    clock.set(EVICT_TIMEOUT_MS);
    coordinator.tick();

    expect(publish).not.toHaveBeenCalled();
  });

  it('ages from event.at, not from wall-clock ingest time: a session whose last REAL activity was already past EVICT_TIMEOUT_MS when observed is evicted on the very next tick', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    const bootTime = 20 * 60 * 60 * 1000; // server starts long after the session went quiet
    const realLastActivity = bootTime - (EVICT_TIMEOUT_MS + 1000); // stale before ingestion even happens

    clock.set(bootTime);
    coordinator.observe(sessionStart('claude-code:stale', 'claude-code', realLastActivity));

    // No further clock advance: eviction must already be overdue at the CURRENT wall-clock time,
    // proving `lastEventAt` came from `event.at`, not from `clock.now()` at observe() time (which
    // would have stamped `bootTime` itself, leaving `elapsed` at 0).
    coordinator.tick();

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.sessionKey).toBe('claude-code:stale');
    expect(event.reason).toBe('timeout');
  });

  it('adversarial twin: a session whose last REAL activity was mere seconds before ingestion is NOT evicted, even at the same far-future wall-clock ingest time', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    const bootTime = 20 * 60 * 60 * 1000;
    const realLastActivity = bootTime - 5000; // 5s before boot — genuinely active

    clock.set(bootTime);
    coordinator.observe(sessionStart('claude-code:fresh', 'claude-code', realLastActivity));

    coordinator.tick();

    expect(publish).not.toHaveBeenCalled();
  });

  it('recordActivity also ages from event.at, not wall-clock ingest time: a replayed activity event carrying a stale timestamp does not rescue a session from eviction', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    const bootTime = 20 * 60 * 60 * 1000;
    const staleStart = bootTime - (EVICT_TIMEOUT_MS + 5000);
    const staleActivity = bootTime - (EVICT_TIMEOUT_MS + 1000); // still stale, just less so

    clock.set(bootTime);
    coordinator.observe(sessionStart('claude-code:stale', 'claude-code', staleStart));
    coordinator.observe(toolStart('claude-code:stale', 'claude-code', staleActivity));

    coordinator.tick();

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.sessionKey).toBe('claude-code:stale');
    expect(event.reason).toBe('timeout');
  });

  it('never publishes twice for the same session on repeated ticks after eviction', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));

    clock.set(EVICT_TIMEOUT_MS);
    coordinator.tick();
    clock.set(EVICT_TIMEOUT_MS + 1000);
    coordinator.tick();

    expect(publish).toHaveBeenCalledTimes(1);
  });

  /**
   * Replaces an earlier assertion that idle was SILENT. design.md "Session discovery and aging
   * out" specifies "worker dims, stays on stage" for the idle threshold — a UI behaviour the UI
   * can only perform if it is told, and nothing else in the system ever set `Worker.activity` to
   * anything but `'working'`. Silence at this boundary was the defect, not the contract: it left
   * every worker on the floor drawn as actively typing forever.
   */
  it('announces the idle threshold as a status(activity: idle) event, never as an eviction', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));

    clock.set(IDLE_TIMEOUT_MS);
    coordinator.tick();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 'status',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      activity: 'idle',
    });
  });

  it('announces idle exactly once, not on every tick that follows it', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));

    clock.set(IDLE_TIMEOUT_MS);
    coordinator.tick();
    clock.set(IDLE_TIMEOUT_MS + 1000);
    coordinator.tick();

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('announces the return to work when a real event arrives after the idle threshold', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));

    clock.set(IDLE_TIMEOUT_MS);
    coordinator.tick();
    publish.mockClear();

    coordinator.observe(toolStart('claude-code:s1', 'claude-code', IDLE_TIMEOUT_MS + 1));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 'status',
      sessionKey: 'claude-code:s1',
      activity: 'working',
    });
  });

  it('does not re-announce work for a session that was never idle', () => {
    const { coordinator, publish } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));
    coordinator.observe(toolStart('claude-code:s1', 'claude-code', 1000));

    expect(publish).not.toHaveBeenCalled();
  });

  it('stops tracking a session once a real session_end arrives, so a later tick never re-evicts it', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));
    clock.set(500);
    coordinator.observe({ id: 3, kind: 'session_end', harness: 'claude-code', sessionKey: 'claude-code:s1', at: 500 });

    clock.set(EVICT_TIMEOUT_MS);
    coordinator.tick();

    expect(publish).not.toHaveBeenCalled();
  });
});

/**
 * Regression: correlation/profile events are SYNTHESIZED, and every one of them is stamped with
 * `clock.now()` at the moment the correlator runs (`claude-code/subagent-correlation-
 * coordinator.ts`'s `buildParentEvent`/`publishProfile`/`applyModel`). Feeding those timestamps
 * into `recordActivity` made a session whose transcript was last written HOURS ago look like it
 * had just been active, so the eviction window restarted from process start and the worker sat on
 * the office floor indefinitely. A `parent` event describes STRUCTURE (who launched whom, what
 * model resolved) — it is never evidence that the session is still doing work.
 */
describe('SessionLifecycleCoordinator liveness evidence', () => {
  function parentEvent(sessionKey: string, at: number): AgentEvent {
    return { id: 9, kind: 'parent', harness: 'claude-code', sessionKey, at, correlationId: 'claude-code:parent' };
  }

  it('does not let a synthesized parent event rescue a session from eviction', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1', 'claude-code', 0));

    // The correlator stamps its edge with the CURRENT wall clock, far newer than any real
    // transcript write this session ever made.
    coordinator.observe(parentEvent('claude-code:s1', EVICT_TIMEOUT_MS));

    clock.set(EVICT_TIMEOUT_MS);
    coordinator.tick();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ kind: 'session_end', reason: 'timeout' });
  });

  it('adversarial twin: a REAL activity event at the same timestamp does rescue it', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1', 'claude-code', 0));

    coordinator.observe(toolStart('claude-code:s1', 'claude-code', EVICT_TIMEOUT_MS));

    clock.set(EVICT_TIMEOUT_MS);
    coordinator.tick();

    expect(publish.mock.calls.map((call) => call[0]?.kind)).not.toContain('session_end');
  });

  it('does not let a parent event alone start tracking a session that never started', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(parentEvent('claude-code:ghost', 0));

    clock.set(EVICT_TIMEOUT_MS);
    coordinator.tick();

    expect(publish).not.toHaveBeenCalled();
  });
});

/**
 * Eviction must be reversible. Discovery emits `session_start` ONCE per file (chokidar `add`
 * never fires again for a file that already exists), so a session discovered with a stale mtime
 * is evicted on the very first tick and, before this, could never come back: `observe` dropped
 * events for an untracked session and `applyEventToOfficeState`'s default branch dropped events
 * for an unknown worker. Observed live — the only session actually writing to disk was the one
 * missing from the office floor, while three sessions that had gone quiet stayed on it.
 */
describe('SessionLifecycleCoordinator re-admission after a timeout eviction', () => {
  function evictedCoordinator(sessionKey = 'claude-code:s1', start: AgentEvent = sessionStart(sessionKey, 'claude-code', 0)) {
    const harness = makeCoordinator();
    harness.coordinator.observe(start);
    harness.clock.set(EVICT_TIMEOUT_MS);
    harness.coordinator.tick();
    harness.publish.mockClear();
    return harness;
  }

  it('republishes a session_start when a timed-out session proves it is alive again', () => {
    const { coordinator, publish } = evictedCoordinator();

    coordinator.observe(toolStart('claude-code:s1', 'claude-code', EVICT_TIMEOUT_MS + 60_000));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 'session_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: EVICT_TIMEOUT_MS + 60_000,
    });
  });

  /**
   * The office rebuilds the worker from this event alone, so anything the original discovery knew
   * has to travel on it — a re-admitted worker that lost its `projectPath` would rejoin the floor
   * as an unattributed agent and the project roster would count it under no project at all.
   */
  it('carries the original discovery identity back onto the republished session_start', () => {
    const discovered: AgentEvent = {
      ...sessionStart('claude-code:s1', 'claude-code', 0),
      label: 'my-session',
      projectPath: '/Users/me/Documents/especializacionIA',
      agentProfile: { role: 'orchestrator', model: 'claude-opus-5' },
    };
    const { coordinator, publish } = evictedCoordinator('claude-code:s1', discovered);

    coordinator.observe(toolStart('claude-code:s1', 'claude-code', EVICT_TIMEOUT_MS + 60_000));

    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      label: 'my-session',
      projectPath: '/Users/me/Documents/especializacionIA',
      agentProfile: { role: 'orchestrator', model: 'claude-opus-5' },
    });
  });

  it('re-ages the re-admitted session from the event that revived it, so it can be evicted again', () => {
    const { coordinator, publish, clock } = evictedCoordinator();
    const revivedAt = EVICT_TIMEOUT_MS + 60_000;
    coordinator.observe(toolStart('claude-code:s1', 'claude-code', revivedAt));
    publish.mockClear();

    // One tick just short of a FULL fresh window must not evict it again...
    clock.set(revivedAt + EVICT_TIMEOUT_MS - 1);
    coordinator.tick();
    expect(publish.mock.calls.map((call) => call[0]?.kind)).not.toContain('session_end');

    // ...and one tick at the fresh deadline must.
    clock.set(revivedAt + EVICT_TIMEOUT_MS);
    coordinator.tick();
    expect(publish.mock.calls.map((call) => call[0]?.kind)).toContain('session_end');
  });

  it('does not republish a session_start for a session that is still tracked and working', () => {
    const { coordinator, publish } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1', 'claude-code', 0));
    publish.mockClear();

    coordinator.observe(toolStart('claude-code:s1', 'claude-code', 1_000));

    expect(publish).not.toHaveBeenCalled();
  });

  /**
   * Adversarial twin of the `liveness evidence` block above: the same reason a `parent` event
   * cannot RESCUE a session from eviction is the reason it cannot REVIVE one afterwards — it is
   * synthesized structure stamped with the current wall clock, not evidence of work.
   */
  it('does not let a parent event revive an evicted session', () => {
    const { coordinator, publish } = evictedCoordinator();

    coordinator.observe({
      id: 9,
      kind: 'parent',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: EVICT_TIMEOUT_MS + 60_000,
      correlationId: 'claude-code:parent',
    });

    expect(publish).not.toHaveBeenCalled();
  });

  /** A harness that explicitly ends a session means it: only a TIMEOUT eviction is reversible. */
  it('does not revive a session that ended explicitly rather than by timeout', () => {
    const { coordinator, publish } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1', 'claude-code', 0));
    coordinator.observe({ id: 3, kind: 'session_end', harness: 'claude-code', sessionKey: 'claude-code:s1', at: 1_000 });
    publish.mockClear();

    coordinator.observe(toolStart('claude-code:s1', 'claude-code', 2_000));

    expect(publish).not.toHaveBeenCalled();
  });
});
