import { describe, expect, it } from 'vitest';
import { createAgentTree, registerSession } from '../../../domain/agents/agent-tree';
import type { ClaudeCodeSessionRef } from './discover';
import type { ClaudeCodeRecord } from './parse';
import { correlateClaudeCodeSession, correlateFromParentRecord } from './correlate';

function subagentRef(overrides: Partial<ClaudeCodeSessionRef> = {}): ClaudeCodeSessionRef {
  return {
    harness: 'claude-code',
    sessionKey: 'claude-code:abc123',
    filePath: '/tmp/subagents/agent-abc123.jsonl',
    isSubagent: true,
    parentSessionKey: 'claude-code:parent-session-1',
    discoveredAt: 0,
    ...overrides,
  };
}

describe('correlateClaudeCodeSession (directory-name edge)', () => {
  it('links a subagent session to its already-known parent using the path-derived parentSessionKey', () => {
    const tree = createAgentTree();
    correlateClaudeCodeSession(tree, subagentRef({ sessionKey: 'claude-code:parent-session-1', isSubagent: false, parentSessionKey: null }), 0);
    correlateClaudeCodeSession(tree, subagentRef(), 0);

    expect(tree.nodes.get('claude-code:abc123')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });

  it('resolves the link once the parent registers, even when the subagent was discovered first', () => {
    const tree = createAgentTree();
    correlateClaudeCodeSession(tree, subagentRef(), 0);
    expect(tree.nodes.get('claude-code:abc123')?.parentSessionKey).toBeNull();

    correlateClaudeCodeSession(tree, subagentRef({ sessionKey: 'claude-code:parent-session-1', isSubagent: false, parentSessionKey: null }), 0);

    expect(tree.nodes.get('claude-code:abc123')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });

  it('registers a top-level (non-subagent) session as a root node', () => {
    const tree = createAgentTree();
    correlateClaudeCodeSession(
      tree,
      subagentRef({ sessionKey: 'claude-code:session-abc', isSubagent: false, parentSessionKey: null }),
      0,
    );

    expect(tree.nodes.get('claude-code:session-abc')?.parentSessionKey).toBeNull();
  });
});

describe('correlateFromParentRecord (agentId edge)', () => {
  it('links a subagent to its parent using toolUseResult.agentId ALONE, with no attributionAgent field present', () => {
    const tree = createAgentTree();
    registerSession(tree, 'claude-code:parent-session-1');
    const record: ClaudeCodeRecord = {
      type: 'user',
      toolUseResult: { agentId: 'abc123', description: 'Auditar rutas' },
    };
    // No `attributionAgent` field anywhere on this record.
    expect('attributionAgent' in record).toBe(false);

    correlateFromParentRecord(tree, 'claude-code:parent-session-1', record, 0);

    expect(tree.nodes.get('claude-code:abc123')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });

  it('resolves the same correlation even when attributionAgent is present with an unrelated value', () => {
    const tree = createAgentTree();
    registerSession(tree, 'claude-code:parent-session-1');
    const record: ClaudeCodeRecord = {
      type: 'user',
      attributionAgent: 'totally-unrelated-label',
      toolUseResult: { agentId: 'xyz789' },
    };

    correlateFromParentRecord(tree, 'claude-code:parent-session-1', record, 0);

    expect(tree.nodes.get('claude-code:xyz789')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });

  it('does nothing when the record carries no toolUseResult.agentId', () => {
    const tree = createAgentTree();
    const record: ClaudeCodeRecord = { type: 'user' };

    correlateFromParentRecord(tree, 'claude-code:parent-session-1', record, 0);

    expect(tree.nodes.size).toBe(0);
  });

  it('correlation succeeds via agentId even when attributionAgent is absent, proving label absence never blocks it', () => {
    const tree = createAgentTree();
    registerSession(tree, 'claude-code:parent-session-1');
    const record: ClaudeCodeRecord = {
      type: 'assistant',
      isSidechain: true,
      agentId: 'a50ed6015d52cbd51',
      toolUseResult: { agentId: 'a50ed6015d52cbd51' },
    };
    expect(record.attributionAgent).toBeUndefined();

    correlateFromParentRecord(tree, 'claude-code:parent-session-1', record, 0);

    expect(tree.nodes.get('claude-code:a50ed6015d52cbd51')?.parentSessionKey).toBe('claude-code:parent-session-1');
  });
});
