/**
 * Session lifecycle (design.md: "Session discovery and aging out").
 * No event for `idleTimeoutMs` -> idle (worker dims, stays on stage). No event for
 * `evictTimeoutMs` -> ended, and the caller should emit a synthetic session_end(reason:'timeout').
 * `now` is an explicit parameter — a fake clock by construction, no wall-clock read, no timer.
 */

export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const EVICT_TIMEOUT_MS = 60 * 60 * 1000;

export type SessionStatus = 'active' | 'idle' | 'ended';

export interface SessionLifecycleState {
  sessionKey: string;
  status: SessionStatus;
  lastEventAt: number;
}

export interface SyntheticSessionEndEvent {
  kind: 'session_end';
  sessionKey: string;
  at: number;
  reason: 'timeout';
}

export interface SessionAgingResult {
  state: SessionLifecycleState;
  emittedEvent: SyntheticSessionEndEvent | null;
}

export function startSession(sessionKey: string, now: number): SessionLifecycleState {
  return { sessionKey, status: 'active', lastEventAt: now };
}

export function recordActivity(state: SessionLifecycleState, now: number): SessionLifecycleState {
  if (state.status === 'ended') return state;
  return { ...state, status: 'active', lastEventAt: now };
}

export function ageSession(
  state: SessionLifecycleState,
  now: number,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  evictTimeoutMs = EVICT_TIMEOUT_MS,
): SessionAgingResult {
  if (state.status === 'ended') return { state, emittedEvent: null };

  const elapsed = now - state.lastEventAt;

  if (elapsed >= evictTimeoutMs) {
    return {
      state: { ...state, status: 'ended' },
      emittedEvent: { kind: 'session_end', sessionKey: state.sessionKey, at: now, reason: 'timeout' },
    };
  }
  if (elapsed >= idleTimeoutMs && state.status !== 'idle') {
    return { state: { ...state, status: 'idle' }, emittedEvent: null };
  }
  return { state, emittedEvent: null };
}
