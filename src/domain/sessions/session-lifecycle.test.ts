import { describe, expect, it } from 'vitest';
import { ageSession, EVICT_TIMEOUT_MS, IDLE_TIMEOUT_MS, startSession } from './session-lifecycle';

// Requirement: idle-then-evict transition, fake-clock driven (explicit `now`, no real waiting).
describe('session lifecycle aging', () => {
  it('transitions to idle after idleTimeoutMs with no synthetic event yet', () => {
    const session = startSession('claude-code:s1', 0);

    const result = ageSession(session, IDLE_TIMEOUT_MS);

    expect(result.state.status).toBe('idle');
    expect(result.emittedEvent).toBeNull();
  });

  it('transitions idle -> ended and emits session_end(reason: timeout) at evictTimeoutMs', () => {
    const session = startSession('claude-code:s1', 0);
    const idled = ageSession(session, IDLE_TIMEOUT_MS).state;

    const evicted = ageSession(idled, EVICT_TIMEOUT_MS);

    expect(evicted.state.status).toBe('ended');
    expect(evicted.emittedEvent).toEqual({
      kind: 'session_end',
      sessionKey: 'claude-code:s1',
      at: EVICT_TIMEOUT_MS,
      reason: 'timeout',
    });
  });
});
