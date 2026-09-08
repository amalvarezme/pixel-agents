/**
 * Launch <-> log correlation (tasks.md Phase 25, design.md "Launch <-> log correlation"). A PURE
 * state machine — every function takes an explicit time parameter, matching this codebase's
 * established fake-clock style (`domain/sessions/session-lifecycle.ts`'s `ageSession`). No
 * internal timer: the caller decides when to call `expireTimedOutClaims`, exactly like the
 * session-aging poller decides when to call `ageSession`.
 *
 * We cannot inject a session id into a harness, so a launch is correlated to the session it
 * produced by OBSERVATION: a claim window `[t0-2s, t1+30s]` scoped to `(harness, cwd)`, offered
 * every newly discovered session. Exactly one match binds; zero or more than one binds NONE
 * (never guess) and degrades attribution only — ingestion is entirely unaffected either way.
 *
 * Antigravity's transcript carries no cwd (design.md), so its candidates carry `cwd: null` and
 * match on harness + window alone — safe only because the serialization guard below ensures at
 * most one open claim per harness can exist for it at a time (its `cwd` is always the same
 * launch-spec cwd in practice, since Antigravity is launched from one workspace at a time).
 */
import type { HarnessId } from '../../../domain/events/types';

export const CLAIM_PRE_WINDOW_MS = 2000;
export const CLAIM_POST_WINDOW_MS = 30_000;

export type ClaimStatus = 'open' | 'bound' | 'ambiguous' | 'timed_out';

export interface LaunchClaim {
  launchId: string;
  harness: HarnessId;
  cwd: string;
  windowStart: number;
  windowEnd: number;
  status: ClaimStatus;
  boundSessionKey: string | null;
}

/** A newly discovered session, offered to every open claim. `cwd: null` when unknown (Antigravity). */
export interface CandidateSession {
  harness: HarnessId;
  sessionKey: string;
  cwd: string | null;
  discoveredAt: number;
}

export type CorrelationOutcome =
  | { kind: 'bound'; launchId: string; sessionKey: string }
  | { kind: 'ambiguous'; launchId: string }
  | { kind: 'timed_out'; launchId: string };

export interface LaunchCorrelatorState {
  claims: LaunchClaim[];
  /** `"${harness}:${cwd}"` -> launchIds waiting for the currently open claim to resolve. */
  pendingQueue: Map<string, string[]>;
}

export function createLaunchCorrelatorState(): LaunchCorrelatorState {
  return { claims: [], pendingQueue: new Map() };
}

function claimKey(harness: HarnessId, cwd: string): string {
  return `${harness}:${cwd}`;
}

function hasOpenClaim(state: LaunchCorrelatorState, harness: HarnessId, cwd: string): boolean {
  return state.claims.some((c) => c.harness === harness && c.cwd === cwd && c.status === 'open');
}

/**
 * Task 25.1/25.4/25.5: records the claim window `[t0-2s, t1+30s]` before/at spawn, scoped to
 * (harness, cwd). If a claim is already open for that pair, this request queues instead of
 * opening a second unclaimed claim — the serialization guard that makes "exactly one candidate"
 * achievable in practice.
 */
export function requestClaim(
  state: LaunchCorrelatorState,
  launchId: string,
  harness: HarnessId,
  cwd: string,
  t0: number,
  t1: number,
): { state: LaunchCorrelatorState; opened: boolean } {
  if (hasOpenClaim(state, harness, cwd)) {
    const key = claimKey(harness, cwd);
    const pendingQueue = new Map(state.pendingQueue);
    pendingQueue.set(key, [...(pendingQueue.get(key) ?? []), launchId]);
    return { state: { ...state, pendingQueue }, opened: false };
  }

  const claim: LaunchClaim = {
    launchId,
    harness,
    cwd,
    windowStart: t0 - CLAIM_PRE_WINDOW_MS,
    windowEnd: t1 + CLAIM_POST_WINDOW_MS,
    status: 'open',
    boundSessionKey: null,
  };
  return { state: { ...state, claims: [...state.claims, claim] }, opened: true };
}

/** Task 25.2: per-harness match predicate, generalized: cwd must agree UNLESS the candidate cannot report one. */
function claimWindowMatchesCandidate(claim: LaunchClaim, candidate: CandidateSession): boolean {
  if (claim.harness !== candidate.harness) return false;
  if (candidate.discoveredAt < claim.windowStart || candidate.discoveredAt > claim.windowEnd) return false;
  if (candidate.cwd !== null && candidate.cwd !== claim.cwd) return false;
  return true;
}

/**
 * Task 25.3: the FIRST matching candidate for an open claim binds it (`launch_bound`). A SECOND,
 * DIFFERENT candidate matching an already-bound claim proves the window was not selective enough
 * to identify one session — it revokes the bind and moves the claim to `ambiguous`
 * (`status(launch_correlation_ambiguous)`), never guessing which of the two is correct. Re-offering
 * the SAME session the claim already bound to is a no-op (idempotent under duplicate discovery).
 */
export function offerCandidate(
  state: LaunchCorrelatorState,
  candidate: CandidateSession,
): { state: LaunchCorrelatorState; outcomes: CorrelationOutcome[] } {
  const outcomes: CorrelationOutcome[] = [];
  const claims = state.claims.map((c) => {
    if (c.status === 'ambiguous' || c.status === 'timed_out') return c;
    if (!claimWindowMatchesCandidate(c, candidate)) return c;

    if (c.status === 'open') {
      outcomes.push({ kind: 'bound', launchId: c.launchId, sessionKey: candidate.sessionKey });
      return { ...c, status: 'bound' as const, boundSessionKey: candidate.sessionKey };
    }
    // c.status === 'bound'
    if (c.boundSessionKey === candidate.sessionKey) return c;
    outcomes.push({ kind: 'ambiguous', launchId: c.launchId });
    return { ...c, status: 'ambiguous' as const, boundSessionKey: null };
  });
  return { state: { ...state, claims }, outcomes };
}

/** Task 25.3: a claim whose window has fully closed with no bind times out — attribution only, never ingestion. */
export function expireTimedOutClaims(
  state: LaunchCorrelatorState,
  now: number,
): { state: LaunchCorrelatorState; outcomes: CorrelationOutcome[] } {
  const outcomes: CorrelationOutcome[] = [];
  const claims = state.claims.map((c) => {
    if (c.status !== 'open' || now <= c.windowEnd) return c;
    outcomes.push({ kind: 'timed_out', launchId: c.launchId });
    return { ...c, status: 'timed_out' as const };
  });
  return { state: { ...state, claims }, outcomes };
}
