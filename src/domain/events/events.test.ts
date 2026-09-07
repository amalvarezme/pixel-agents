import { describe, expect, it } from 'vitest';
import { createEventFromLogRecord, createSelfOriginatedEvent } from './factories';
import { EventKind, isEventKind } from './types';

// Requirement: Canonical Event Type Set — exactly eleven kinds, no twelfth constructible.
describe('canonical event type set', () => {
  it('recognizes all eleven canonical kinds', () => {
    const canonicalKinds: EventKind[] = [
      'session_start',
      'tool_start',
      'tool_end',
      'message',
      'stats',
      'status',
      'parent',
      'session_end',
      'memory_write',
      'launch_requested',
      'launch_started',
    ];

    expect(canonicalKinds.every(isEventKind)).toBe(true);
    expect(canonicalKinds).toHaveLength(11);
  });

  it('rejects a twelfth, non-canonical kind', () => {
    expect(isEventKind('agent_summoned')).toBe(false);
    expect(() =>
      createEventFromLogRecord(1, {
        // @ts-expect-error — deliberately outside the canonical union to prove the guard fires
        kind: 'agent_summoned',
        harness: 'claude-code',
        sessionKey: 'claude-code:s1',
        at: 0,
      }),
    ).toThrow(/cannot construct/);
  });
});

// Requirement: Event Origination Provenance — launch_* events never come from a log parse.
describe('event origination provenance', () => {
  it('rejects launch_requested/launch_started from the log-record factory', () => {
    expect(() =>
      createEventFromLogRecord(1, {
        // @ts-expect-error — self-originated kinds are excluded from LogSourcedEventKind
        kind: 'launch_requested',
        harness: 'claude-code',
        sessionKey: 'claude-code:s1',
        at: 0,
      }),
    ).toThrow(/cannot construct self-originated kind: "launch_requested"/);
  });

  it('accepts launch_requested/launch_started only from the self-originated factory', () => {
    const event = createSelfOriginatedEvent(1, {
      kind: 'launch_started',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1000,
    });

    expect(event.kind).toBe('launch_started');
  });
});
