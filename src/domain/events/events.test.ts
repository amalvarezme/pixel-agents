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

// Requirement: normalized {toolLabel, toolDetail} caption pair on tool_start (tasks.md 21.5,
// design.md "Captions") — carried on the shared envelope so the renderer can consume it without
// ever branching on `kind` or `harness`.
describe('tool_start caption normalization fields', () => {
  it('carries an optional toolLabel/toolDetail pair through the log-record factory', () => {
    const event = createEventFromLogRecord(1, {
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1000,
      toolLabel: 'Read',
      toolDetail: 'design.md',
    });

    expect(event.toolLabel).toBe('Read');
    expect(event.toolDetail).toBe('design.md');
  });

  it('omits toolLabel/toolDetail when the caller does not supply them', () => {
    const event = createEventFromLogRecord(1, {
      kind: 'tool_start',
      harness: 'claude-code',
      sessionKey: 'claude-code:s1',
      at: 1000,
    });

    expect(event.toolLabel).toBeUndefined();
    expect(event.toolDetail).toBeUndefined();
  });
});

// tasks.md 24.6: launch_requested/launch_started carry the launcher's OWN process state
// (launchId, resolved binary path, argv, cwd, pid, startedAt) — design.md "The Launcher".
describe('self-originated launch event payload fields (tasks.md 24.6)', () => {
  it('carries launchId/binaryPath/argv/cwd on launch_requested', () => {
    const event = createSelfOriginatedEvent(1, {
      kind: 'launch_requested',
      harness: 'claude-code',
      sessionKey: 'launch:abc123',
      at: 1000,
      launchId: 'abc123',
      binaryPath: '/usr/local/bin/claude',
      argv: ['claude', '--resume', 'x'],
      cwd: '/Users/dev/project',
    });

    expect(event.launchId).toBe('abc123');
    expect(event.binaryPath).toBe('/usr/local/bin/claude');
    expect(event.argv).toEqual(['claude', '--resume', 'x']);
    expect(event.cwd).toBe('/Users/dev/project');
  });

  it('carries pid/startedAt on launch_started (triangulation: a different field set for a different kind)', () => {
    const event = createSelfOriginatedEvent(2, {
      kind: 'launch_started',
      harness: 'claude-code',
      sessionKey: 'launch:abc123',
      at: 1005,
      launchId: 'abc123',
      pid: 4242,
      startedAt: 1005,
    });

    expect(event.pid).toBe(4242);
    expect(event.startedAt).toBe(1005);
  });
});
