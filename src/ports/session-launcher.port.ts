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
}

export type LaunchResult =
  | { outcome: 'started'; launchId: string; pid: number; startedAt: number }
  | { outcome: 'failed'; launchId: string; reason: string };

export interface SessionLauncher {
  launch(spec: LaunchSpec): Promise<LaunchResult>;
  shutdown(): Promise<void>;
}
