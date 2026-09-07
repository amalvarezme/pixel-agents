import { describe, expect, it } from 'vitest';
import { claimParentChild, createAgentTree, promoteOrphans, registerSession } from './agent-tree';

// Requirement: parent/child correlation must survive out-of-order arrival, and no event is
// ever dropped. Uses explicit `now` timestamps as the fake clock — no real waiting.
describe('AgentTree orphan grace', () => {
  it('resolves a child claimed before its parent once the parent registers', () => {
    const tree = createAgentTree();

    claimParentChild(tree, 'P1', 'C1', 0);
    expect(tree.nodes.get('C1')?.parentSessionKey).toBeNull();
    expect(tree.pending).toHaveLength(1);

    registerSession(tree, 'P1');

    expect(tree.nodes.get('C1')?.parentSessionKey).toBe('P1');
    expect(tree.pending).toHaveLength(0);
  });

  it('promotes an unclaimed child to root after orphanGraceMs, dropping no event', () => {
    const tree = createAgentTree();
    claimParentChild(tree, 'P1', 'C1', 0);

    promoteOrphans(tree, 4999, 5000);
    expect(tree.pending).toHaveLength(1);

    promoteOrphans(tree, 5000, 5000);

    expect(tree.pending).toHaveLength(0);
    expect(tree.nodes.get('C1')?.parentSessionKey).toBeNull();
    expect(tree.nodes.has('C1')).toBe(true);
  });
});
