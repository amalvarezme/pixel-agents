/**
 * Terminal backend capability port (design.md D5). Gates whether the launcher may offer a
 * PTY-backed interactive session, or must fall back to a copyable command line. The slice-1a
 * risk-retirement spike (`src/adapters/driven/terminal/node-pty-probe.ts`) is the first
 * implementation of this port; the launcher (slice 5) consumes it as a gate, never a throw.
 */
export type TerminalBackendAvailability = { available: true } | { available: false; reason: string };

export interface TerminalBackend {
  probe(): Promise<TerminalBackendAvailability>;
}
