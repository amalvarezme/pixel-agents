/**
 * Pi parent/child correlation (spec: "Pi Parent/Child Correlation By Session Hash", design.md D2).
 *
 * Pi's presence registry names each activation by `sha256(parentSessionId)` — see
 * `PresencePublisher`'s constructor in `gentle-pi/lib/orchestrator-presence.ts`. sha256 is one-way,
 * so the join direction is FORCED: hash every session id we already know and look the header's
 * `sessionHash` up in that table. Nothing here ever tries to invert a hash, and nothing here ever
 * infers a parent from filename proximity, timing, or ordering.
 *
 * This is the whole of Pi's correlation. It replaces, for Pi, the ~350-line heuristic coordinator
 * Claude Code needs (`claude-code/subagent-correlation-coordinator.ts`), because Pi publishes the
 * edge instead of leaving it to be guessed.
 *
 * Pure and I/O-free: the caller feeds it discovered session ids.
 */
import { createHash } from 'node:crypto';

export class PiSessionHashIndex {
  /** `sha256(sessionId) -> sessionId`. Built forwards, read backwards. */
  private readonly bySessionHash = new Map<string, string>();
  /** `sessionId -> cwd`, recorded alongside the hash join so a subagent can INHERIT its parent's
   * real project path (Finding F2). A registry header names a project, never a path, so the parent
   * transcript's own `cwd` is the only honest source — and the parent is already identified by the
   * hash join, which makes this a lookup rather than a guess. */
  private readonly cwdBySessionId = new Map<string, string>();

  /**
   * Idempotent for the hash join: re-registering an already-known session is a no-op, not a
   * duplicate. A `cwd` counts as present when it is non-empty (`cwd.length > 0`), so a
   * WHITESPACE-ONLY reading (`'  '`) IS recorded; only `undefined`, `null`, and the empty string are
   * treated as absent — "no path this time", never "the path went away", so they must not erase one
   * already known. A later present `cwd` DOES replace an earlier one (merge-not-erase, mirroring the
   * domain's own discipline).
   */
  register(sessionId: string, cwd?: string | null): void {
    this.bySessionHash.set(createHash('sha256').update(sessionId).digest('hex'), sessionId);
    if (cwd !== undefined && cwd !== null && cwd.length > 0) this.cwdBySessionId.set(sessionId, cwd);
  }

  /** The bare session id for a registry `sessionHash`, or `null` when no known session hashes to it. */
  resolve(sessionHash: string): string | null {
    return this.bySessionHash.get(sessionHash) ?? null;
  }

  /**
   * The resolved parent's OWN known project path for a registry `sessionHash`, or `null`. `null`
   * covers both "no known session hashes to this" and "the session is known but its transcript
   * yielded no cwd" — absence either way, never a fabricated path.
   */
  resolveProjectPath(sessionHash: string): string | null {
    const sessionId = this.resolve(sessionHash);
    if (sessionId === null) return null;
    return this.cwdBySessionId.get(sessionId) ?? null;
  }

  /**
   * The prefixed `sessionKey` a `parent` event needs, or `null`. Separate from `resolve` because
   * the hash is taken over the BARE id while every event carries the `pi:`-prefixed key — conflating
   * the two is exactly the mistake that would silently produce zero correlations.
   */
  resolveSessionKey(sessionHash: string): string | null {
    const sessionId = this.resolve(sessionHash);
    return sessionId === null ? null : `pi:${sessionId}`;
  }

  get size(): number {
    return this.bySessionHash.size;
  }
}
