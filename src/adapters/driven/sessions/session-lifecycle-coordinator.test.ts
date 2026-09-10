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

    expect(publish).not.toHaveBeenCalled();
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

  it('emits nothing at the idle threshold alone (idle is silent by design)', () => {
    const { coordinator, publish, clock } = makeCoordinator();
    coordinator.observe(sessionStart('claude-code:s1'));

    clock.set(IDLE_TIMEOUT_MS);
    coordinator.tick();

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
