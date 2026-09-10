/**
 * Pure bootstrap-window predicate shared by the JSONL adapters' discovery scans (Claude Code,
 * Codex, Antigravity — design.md "Session discovery and aging out": "attach only to sessions
 * touched within `activeWindow` (24h)"). Mirrors the boundary OpenCode's own bootstrap query
 * already applies (`session.time_updated > ?`): a file touched EXACTLY at the cutoff is OUTSIDE
 * the window — the comparison is strict `>`, never `>=`.
 */
export const DEFAULT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinActiveWindow(mtimeMs: number, now: number, activeWindowMs: number): boolean {
  return mtimeMs > now - activeWindowMs;
}
