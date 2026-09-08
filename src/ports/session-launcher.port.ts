/**
 * Session launcher port (design.md: "The Launcher"). Types only in slice 1a — the real
 * `child_process`/PTY-backed implementation, argv builder, and launch<->log correlation land
 * in slice 5. Declared now so `ports/` fully mirrors the module structure up front.
 */
import type { HarnessId } from '../domain/events/types';

export interface LaunchSpec {
  harness: HarnessId;
  cwd: string;
  /** User-supplied free arguments only; the allowlisted template is applied by the adapter. */
  args: string[];
  /** Interactive (PTY-backed) sessions are gated by the terminal backend capability probe. */
  interactive?: boolean;
}

export type LaunchResult =
  | { outcome: 'started'; launchId: string; pid: number; startedAt: number }
  | { outcome: 'failed'; launchId: string; reason: string }
  /**
   * `interactive: true` requested but the PTY backend probe reports `{available:false}`
   * (tasks.md 24.3). Nothing is spawned; the UI is handed a copyable command line for the
   * user's own terminal instead of a silent non-TTY degrade.
   */
  | { outcome: 'unavailable_interactive'; launchId: string; commandLine: string; reason: string };

export interface SessionLauncher {
  launch(spec: LaunchSpec): Promise<LaunchResult>;
  shutdown(): Promise<void>;
}
