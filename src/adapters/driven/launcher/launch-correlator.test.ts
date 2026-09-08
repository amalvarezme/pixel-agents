/**
 * `LaunchCorrelator` (tasks.md Phase 25, design.md "Launch <-> log correlation"). Pure,
 * fake-clock-driven state machine — every timing input is an explicit `now`/`t0`/`t1` parameter,
 * matching this codebase's established style (`domain/sessions/session-lifecycle.ts`). No
 * internal timer, no real waiting: `expireTimedOutClaims` is called by the caller with an
 * explicit `now`, exactly like `ageSession`.
 */
import { describe, expect, it } from 'vitest';
import {
  createLaunchCorrelatorState,
  expireTimedOutClaims,
  offerCandidate,
  requestClaim,
  type CandidateSession,
} from './launch-correlator';

const HARNESS = 'claude-code' as const;
const CWD = '/Users/dev/project';

describe('LaunchCorrelator — claim window (task 25.1)', () => {
  it('opens a claim window [t0-2s, t1+30s] scoped to (harness, cwd)', () => {
    const state = createLaunchCorrelatorState();

    const { state: next, opened } = requestClaim(state, 'launch-1', HARNESS, CWD, 10_000, 10_050);

    expect(opened).toBe(true);
    expect(next.claims).toEqual([
      { launchId: 'launch-1', harness: HARNESS, cwd: CWD, windowStart: 8_000, windowEnd: 40_050, status: 'open', boundSessionKey: null },
    ]);
  });
});

describe('LaunchCorrelator — per-harness match + ambiguity policy (task 25.2/25.3)', () => {
  const candidate = (overrides: Partial<CandidateSession> = {}): CandidateSession => ({
    harness: HARNESS,
    sessionKey: 'claude-code:s1',
    cwd: CWD,
    discoveredAt: 10_010,
    ...overrides,
  });

  it('exactly one matching candidate binds and emits launch_bound', () => {
    const { state } = requestClaim(createLaunchCorrelatorState(), 'launch-1', HARNESS, CWD, 10_000, 10_050);

    const { state: next, outcomes } = offerCandidate(state, candidate());

    expect(outcomes).toEqual([{ kind: 'bound', launchId: 'launch-1', sessionKey: 'claude-code:s1' }]);
    expect(next.claims[0]).toMatchObject({ status: 'bound', boundSessionKey: 'claude-code:s1' });
  });

  it('adversarial near-miss: a candidate for a DIFFERENT cwd in the SAME window never binds', () => {
    const { state } = requestClaim(createLaunchCorrelatorState(), 'launch-1', HARNESS, CWD, 10_000, 10_050);

    const { state: next, outcomes } = offerCandidate(state, candidate({ cwd: '/Users/dev/other-project' }));

    expect(outcomes).toEqual([]);
    expect(next.claims[0]).toMatchObject({ status: 'open' });
  });

  it('adversarial near-miss: a candidate outside the claim window never binds', () => {
    const { state } = requestClaim(createLaunchCorrelatorState(), 'launch-1', HARNESS, CWD, 10_000, 10_050);

    const { state: next, outcomes } = offerCandidate(state, candidate({ discoveredAt: 40_051 }));

    expect(outcomes).toEqual([]);
    expect(next.claims[0]).toMatchObject({ status: 'open' });
  });

  it('two candidates matching the same open claim bind NEITHER — status(launch_correlation_ambiguous)', () => {
    let { state } = requestClaim(createLaunchCorrelatorState(), 'launch-1', HARNESS, CWD, 10_000, 10_050);

    let result = offerCandidate(state, candidate({ sessionKey: 'claude-code:s1' }));
    state = result.state;
    result = offerCandidate(state, candidate({ sessionKey: 'claude-code:s2' }));

    expect(result.outcomes).toEqual([{ kind: 'ambiguous', launchId: 'launch-1' }]);
    expect(result.state.claims[0]).toMatchObject({ status: 'ambiguous', boundSessionKey: null });
  });

  it('a claim past its window with zero candidates times out — status(launch_correlation_timeout)', () => {
    const { state } = requestClaim(createLaunchCorrelatorState(), 'launch-1', HARNESS, CWD, 10_000, 10_050);

    const { state: next, outcomes } = expireTimedOutClaims(state, 40_051);

    expect(outcomes).toEqual([{ kind: 'timed_out', launchId: 'launch-1' }]);
    expect(next.claims[0]).toMatchObject({ status: 'timed_out' });
  });

  it('a claim still inside its window is NOT expired (adversarial near-miss to the timeout test)', () => {
    const { state } = requestClaim(createLaunchCorrelatorState(), 'launch-1', HARNESS, CWD, 10_000, 10_050);

    const { state: next, outcomes } = expireTimedOutClaims(state, 40_050);

    expect(outcomes).toEqual([]);
    expect(next.claims[0]).toMatchObject({ status: 'open' });
  });

  it('antigravity candidates match on harness + window alone (no cwd signal available), per design.md', () => {
    const { state } = requestClaim(createLaunchCorrelatorState(), 'launch-1', 'antigravity', CWD, 10_000, 10_050);

    const { outcomes } = offerCandidate(state, {
      harness: 'antigravity',
      sessionKey: 'antigravity:cli:new-uuid',
      cwd: null,
      discoveredAt: 10_020,
    });

    expect(outcomes).toEqual([{ kind: 'bound', launchId: 'launch-1', sessionKey: 'antigravity:cli:new-uuid' }]);
  });
});

describe('LaunchCorrelator — serialization guard (tasks 25.4/25.5)', () => {
  it('a second request for the SAME (harness,cwd) queues instead of opening a second unclaimed claim', () => {
    const first = requestClaim(createLaunchCorrelatorState(), 'launch-1', HARNESS, CWD, 10_000, 10_050);
    const second = requestClaim(first.state, 'launch-2', HARNESS, CWD, 10_010, 10_060);

    expect(second.opened).toBe(false);
    const openClaims = second.state.claims.filter((c) => c.harness === HARNESS && c.cwd === CWD && c.status === 'open');
    expect(openClaims).toHaveLength(1);
    expect(openClaims[0]?.launchId).toBe('launch-1');
  });

  it('adversarial near-miss: a concurrent request for a DIFFERENT cwd opens its own claim immediately, unaffected by the guard', () => {
    const first = requestClaim(createLaunchCorrelatorState(), 'launch-1', HARNESS, CWD, 10_000, 10_050);
    const second = requestClaim(first.state, 'launch-2', HARNESS, '/Users/dev/other-project', 10_010, 10_060);

    expect(second.opened).toBe(true);
    const openClaims = second.state.claims.filter((c) => c.status === 'open');
    expect(openClaims).toHaveLength(2);
  });

  it('once the first claim resolves, the next queued launchId becomes dequeueable', () => {
    const first = requestClaim(createLaunchCorrelatorState(), 'launch-1', HARNESS, CWD, 10_000, 10_050);
    const second = requestClaim(first.state, 'launch-2', HARNESS, CWD, 10_010, 10_060);

    const bound = offerCandidate(second.state, { harness: HARNESS, sessionKey: 'claude-code:s1', cwd: CWD, discoveredAt: 10_020 });

    expect(bound.state.pendingQueue.get(`${HARNESS}:${CWD}`)).toEqual(['launch-2']);
  });
});
