/**
 * Harness badge atom (tasks.md 10.5). Pure data — no PixiJS import; `ui/scene/pixi/` is the
 * only file allowed to turn this into an actual drawn sprite (design.md D3).
 *
 * Harness identity is a badge + accent color, never a different worker sprite, so a mixed
 * office stays readable (design.md: "The Office Scene").
 */
import type { HarnessId } from '../../../domain/events/types';

export interface HarnessBadge {
  text: string;
  color: string;
}

const HARNESS_BADGES: Record<HarnessId, HarnessBadge> = {
  'claude-code': { text: 'Claude', color: '#d97757' },
  codex: { text: 'Codex', color: '#10a37f' },
  opencode: { text: 'OpenCode', color: '#5865f2' },
  antigravity: { text: 'Antigravity', color: '#4285f4' },
};

export function buildHarnessBadge(harness: HarnessId): HarnessBadge {
  return HARNESS_BADGES[harness];
}
