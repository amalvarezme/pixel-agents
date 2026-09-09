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

function sessionStart(sessionKey: string, harness: AgentEvent['harness'] = 'claude-code'): AgentEvent {
  return { id: 1, kind: 'session_start', harness, sessionKey, at: 0 };
}

function toolStart(sessionKey: string, harness: AgentEvent['harness'] = 'claude-code'): AgentEvent {
  return { id: 2, kind: 'tool_start', harness, sessionKey, at: 0 };
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
    coordinator.observe(sessionStart('codex:fresh', 'codex'));

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
    coordinator.observe(toolStart('claude-code:s1'));

    clock.set(EVICT_TIMEOUT_MS);
    coordinator.tick();

    expect(publish).not.toHaveBeenCalled();
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
