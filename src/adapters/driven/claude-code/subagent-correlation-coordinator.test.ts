import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../domain/events/types';
import type { ClaudeCodeSessionRef } from './discover';
import type { ClaudeCodeRecord } from './parse';
import { ClaudeCodeSubagentCorrelationCoordinator } from './subagent-correlation-coordinator';

function sessionRef(overrides: Partial<ClaudeCodeSessionRef> = {}): ClaudeCodeSessionRef {
  return {
    harness: 'claude-code',
    sessionKey: 'claude-code:parent-1',
    filePath: '/tmp/parent-1.jsonl',
    isSubagent: false,
    parentSessionKey: null,
    cwd: null,
    discoveredAt: 0,
    ...overrides,
  };
}

function subagentRef(overrides: Partial<ClaudeCodeSessionRef> = {}): ClaudeCodeSessionRef {
  return sessionRef({
    sessionKey: 'claude-code:child-1',
    filePath: '/tmp/parent-1/subagents/agent-child-1.jsonl',
    isSubagent: true,
    parentSessionKey: 'claude-code:parent-1',
    ...overrides,
  });
}

function makeCoordinator(): { coordinator: ClaudeCodeSubagentCorrelationCoordinator; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn<(event: AgentEvent) => void>();
  const coordinator = new ClaudeCodeSubagentCorrelationCoordinator(
    { publish },
    { now: () => 1000 },
    (() => {
      let next = 1;
      return () => next++;
    })(),
  );
  return { coordinator, publish };
}

describe('ClaudeCodeSubagentCorrelationCoordinator (directory-name edge)', () => {
  it('publishes a parent event with the correct child/parent sessionKey PAIR once both sides are known', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef());
    coordinator.offerSession(subagentRef());

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.kind).toBe('parent');
    expect(event.sessionKey).toBe('claude-code:child-1');
    expect(event.correlationId).toBe('claude-code:parent-1');
  });

  it('does NOT bind a subagent to the wrong parent when several parents are known', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef({ sessionKey: 'claude-code:other-parent' }));
    coordinator.offerSession(sessionRef());
    coordinator.offerSession(subagentRef());

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.correlationId).toBe('claude-code:parent-1');
    expect(event.correlationId).not.toBe('claude-code:other-parent');
  });

  it('publishes no parent event for a non-subagent (root) session', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef());

    expect(publish).not.toHaveBeenCalled();
  });

  it('resolves and publishes once the parent arrives, even when the subagent was offered first', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(subagentRef());
    expect(publish).not.toHaveBeenCalled();

    coordinator.offerSession(sessionRef());

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.sessionKey).toBe('claude-code:child-1');
    expect(event.correlationId).toBe('claude-code:parent-1');
  });

  it('never publishes twice for the same already-resolved subagent', () => {
    const { coordinator, publish } = makeCoordinator();

    coordinator.offerSession(sessionRef());
    coordinator.offerSession(subagentRef());
    coordinator.offerSession(subagentRef());

    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCodeSubagentCorrelationCoordinator (agentId edge)', () => {
  it('publishes a parent event using toolUseResult.agentId from a parent transcript record', () => {
    const { coordinator, publish } = makeCoordinator();
    const record: ClaudeCodeRecord = { type: 'user', toolUseResult: { agentId: 'agent-xyz' } };

    coordinator.offerSession(sessionRef());
    coordinator.offerParentRecord('claude-code:parent-1', record);

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0];
    expect(event.sessionKey).toBe('claude-code:agent-xyz');
    expect(event.correlationId).toBe('claude-code:parent-1');
  });

  it('publishes nothing when the record carries no toolUseResult.agentId', () => {
    const { coordinator, publish } = makeCoordinator();
    const record: ClaudeCodeRecord = { type: 'user' };

    coordinator.offerSession(sessionRef());
    coordinator.offerParentRecord('claude-code:parent-1', record);

    expect(publish).not.toHaveBeenCalled();
  });
});
