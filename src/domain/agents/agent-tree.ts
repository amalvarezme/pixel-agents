/**
 * Agent correlation tree (design.md: "Correlation and the Agent Tree").
 * Absent linkage is a flat lane, never a crash: a child claimed before its parent is known
 * waits in `pending`, resolves the instant its parent registers, and is promoted to a root
 * node after `orphanGraceMs` if the parent never shows up. No event is ever dropped: every
 * session is added to `nodes` the moment it is seen, regardless of correlation state.
 *
 * Time is an explicit `now: number` parameter (a "fake clock" by construction) rather than a
 * wall-clock read, so this module stays a pure function with zero I/O and no timers.
 */

export const DEFAULT_ORPHAN_GRACE_MS = 5000;

export interface AgentNode {
  sessionKey: string;
  parentSessionKey: string | null;
}

interface PendingChild {
  childSessionKey: string;
  claimedParentSessionKey: string;
  claimedAt: number;
}

export interface AgentTree {
  nodes: Map<string, AgentNode>;
  pending: PendingChild[];
}

export function createAgentTree(): AgentTree {
  return { nodes: new Map(), pending: [] };
}

/** Registers a session as a node (root by default) and resolves any children waiting on it. */
export function registerSession(tree: AgentTree, sessionKey: string): void {
  if (!tree.nodes.has(sessionKey)) {
    tree.nodes.set(sessionKey, { sessionKey, parentSessionKey: null });
  }
  const resolvable = tree.pending.filter((p) => p.claimedParentSessionKey === sessionKey);
  for (const p of resolvable) {
    const child = tree.nodes.get(p.childSessionKey);
    if (child) child.parentSessionKey = sessionKey;
  }
  tree.pending = tree.pending.filter((p) => p.claimedParentSessionKey !== sessionKey);
}

/** Claims a parent/child correlation. Resolves immediately if the parent is already known. */
export function claimParentChild(
  tree: AgentTree,
  parentSessionKey: string,
  childSessionKey: string,
  now: number,
): void {
  registerSession(tree, childSessionKey);
  const parent = tree.nodes.get(parentSessionKey);
  if (parent) {
    tree.nodes.get(childSessionKey)!.parentSessionKey = parentSessionKey;
    return;
  }
  tree.pending.push({ childSessionKey, claimedParentSessionKey: parentSessionKey, claimedAt: now });
}

/** Promotes any pending claim older than `orphanGraceMs` to a root node (parent never arrived). */
export function promoteOrphans(tree: AgentTree, now: number, orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS): void {
  tree.pending = tree.pending.filter((p) => now - p.claimedAt < orphanGraceMs);
}
