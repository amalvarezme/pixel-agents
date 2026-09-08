/**
 * Use case: launch-agent-session (tasks.md 26.1, design.md module structure). See the test file
 * header for why this is a thin delegation rather than duplicated orchestration: the
 * `SessionLauncher` port already owns argv building, binary resolution, spawning, and all
 * self-originated event emission. This use case exists to keep the driving HTTP adapter dependent
 * on `application/` -> `ports/`, never directly on a concrete adapter.
 */
import type { LaunchResult, LaunchSpec, SessionLauncher } from '../../ports/session-launcher.port';

export async function launchAgentSession(launcher: SessionLauncher, spec: LaunchSpec): Promise<LaunchResult> {
  return launcher.launch(spec);
}
