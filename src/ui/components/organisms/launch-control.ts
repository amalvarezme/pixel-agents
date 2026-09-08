/**
 * Launcher UI control organism (tasks.md 26.2, spec: "Supported Launch Targets"). Pure view
 * builder — no DOM, no fetch. `ui/main.ts` renders `LaunchControlView.targets` and wires each
 * one's click to `OfficeContainer.requestLaunch`.
 */
import type { HarnessId } from '../../../domain/events/types';

export interface LaunchTargetView {
  harness: HarnessId;
  label: string;
}

export interface LaunchControlView {
  targets: LaunchTargetView[];
}

const LAUNCH_TARGET_LABELS: Record<HarnessId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
};

export function buildLaunchControlView(): LaunchControlView {
  return {
    targets: (Object.keys(LAUNCH_TARGET_LABELS) as HarnessId[]).map((harness) => ({
      harness,
      label: LAUNCH_TARGET_LABELS[harness],
    })),
  };
}
