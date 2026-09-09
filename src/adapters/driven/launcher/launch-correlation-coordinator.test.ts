/**
 * `LaunchCorrelationCoordinator` (tasks.md Phase 25 follow-up: wiring the pure `launch-
 * correlator.ts` state machine into a stateful, event-publishing coordinator). This is the piece
 * that turns the pure claim-window state machine into something a composition root can call on
 * real launches and real discovered sessions, translating each `CorrelationOutcome` into a
 * `status` event on the shared bus (design.md "Launch <-> log correlation": `launch_bound`,
 * `status(launch_correlation_ambiguous)`, `status(launch_correlation_timeout)`).
 *
 * A failed bind (ambiguous or timed out) degrades attribution only — it must never throw and
 * must never touch ingestion in any way, matching `launch-correlator.ts`'s own invariant.
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../domain/events/types';
import { LaunchCorrelationCoordinator } from './launch-correlation-coordinator';

const HARNESS = 'claude-code' as const;
const CWD = '/Users/dev/project';

function makeCoordinator(nowValues: number[]): { coordinator: LaunchCorrelationCoordinator; published: AgentEvent[] } {
  const published: AgentEvent[] = [];
  let callIndex = 0;
  const coordinator = new LaunchCorrelationCoordinator({
    publisher: { publish: (event) => published.push(event) },
    clock: { now: () => nowValues[Math.min(callIndex++, nowValues.length - 1)] ?? 0 },
  });
  return { coordinator, published };
}

describe('LaunchCorrelationCoordinator', () => {
  it('exactly one matching candidate binds and publishes status(launch_bound) with the bound sessionKey and launchId', () => {
    const { coordinator, published } = makeCoordinator([10_020]);

    coordinator.requestClaim('launch-1', HARNESS, CWD, 10_000, 10_050);
    coordinator.offerCandidate({ harness: HARNESS, sessionKey: 'claude-code:s1', cwd: CWD, discoveredAt: 10_010 });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      kind: 'status',
      harness: HARNESS,
      sessionKey: 'claude-code:s1',
      launchId: 'launch-1',
      reason: 'launch_bound',
    });
  });

  it('adversarial near-miss: two DIFFERENT candidates for the same claim never bind — publishes status(launch_correlation_ambiguous), not launch_bound', () => {
    const { coordinator, published } = makeCoordinator([10_010, 10_020]);

    coordinator.requestClaim('launch-1', HARNESS, CWD, 10_000, 10_050);
    coordinator.offerCandidate({ harness: HARNESS, sessionKey: 'claude-code:s1', cwd: CWD, discoveredAt: 10_010 });
    coordinator.offerCandidate({ harness: HARNESS, sessionKey: 'claude-code:s2', cwd: CWD, discoveredAt: 10_020 });

    expect(published).toHaveLength(2);
    expect(published[0]?.reason).toBe('launch_bound');
    expect(published[1]).toMatchObject({
      kind: 'status',
      harness: HARNESS,
      sessionKey: 'launch:launch-1',
      launchId: 'launch-1',
      reason: 'launch_correlation_ambiguous',
    });
  });

  it('a claim past its window with zero candidates publishes status(launch_correlation_timeout) on the next expiry tick', () => {
    const { coordinator, published } = makeCoordinator([40_051]);

    coordinator.requestClaim('launch-1', HARNESS, CWD, 10_000, 10_050);
    coordinator.expireTimedOutClaims();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      kind: 'status',
      harness: HARNESS,
      sessionKey: 'launch:launch-1',
      launchId: 'launch-1',
      reason: 'launch_correlation_timeout',
    });
  });

  it('adversarial near-miss: a claim still inside its window is NOT expired — publishes nothing', () => {
    const { coordinator, published } = makeCoordinator([10_049]);

    coordinator.requestClaim('launch-1', HARNESS, CWD, 10_000, 10_050);
    coordinator.expireTimedOutClaims();

    expect(published).toEqual([]);
  });

  it('a failed bind (ambiguous) never throws and publishes nothing beyond the two status events — degrades attribution only', () => {
    const { coordinator, published } = makeCoordinator([10_010, 10_020]);

    coordinator.requestClaim('launch-1', HARNESS, CWD, 10_000, 10_050);
    expect(() => {
      coordinator.offerCandidate({ harness: HARNESS, sessionKey: 'claude-code:s1', cwd: CWD, discoveredAt: 10_010 });
      coordinator.offerCandidate({ harness: HARNESS, sessionKey: 'claude-code:s2', cwd: CWD, discoveredAt: 10_020 });
    }).not.toThrow();

    expect(published.map((e) => e.reason)).toEqual(['launch_bound', 'launch_correlation_ambiguous']);
  });

  it('a candidate with no matching open claim publishes nothing (no open claims to offer against)', () => {
    const { coordinator, published } = makeCoordinator([10_010]);

    coordinator.offerCandidate({ harness: HARNESS, sessionKey: 'claude-code:s1', cwd: CWD, discoveredAt: 10_010 });

    expect(published).toEqual([]);
  });
});
