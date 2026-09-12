import { describe, expect, it } from 'vitest';
import { resolveProjectCharacterColor } from './project-accent';

// Realistic absolute project paths, pre-verified to land on DIFFERENT palette entries (a hash can
// always collide, but this project's palette has 10 entries and these six do not).
const PROJECT_A = '/Users/andresalvarez/Documents/pixel-agents';
const PROJECT_B = '/Users/andresalvarez/Documents/other-project';
const PROJECT_C = '/home/ci/workspace/service-api';
const PROJECT_D = '/home/ci/workspace/service-worker';
const PROJECT_E = '/Users/jane/dev/mobile-client';
const PROJECT_F = '/var/lib/build/analytics-pipeline';

const HARNESS_ACCENT_COLOR = 0xffd166; // ORCHESTRATOR_ACCENT_COLOR in character-pose.ts

describe('resolveProjectCharacterColor — deterministic per-project character colour', () => {
  it('returns the same colour for the same project path every time', () => {
    expect(resolveProjectCharacterColor(PROJECT_A)).toBe(resolveProjectCharacterColor(PROJECT_A));
  });

  // Adversarial twin: a DIFFERENT project path must resolve to a different colour — proves the
  // colour is actually derived from the path, not a constant.
  it('returns a different colour for a different project path', () => {
    expect(resolveProjectCharacterColor(PROJECT_A)).not.toBe(resolveProjectCharacterColor(PROJECT_B));
  });

  // Several REALISTIC, different project paths must spread across different palette entries —
  // the whole point of hashing into a palette (model-accent.ts's precedent) instead of a fixed
  // per-project colour list that would need to know every project in advance.
  it('spreads several realistic, different project paths across different colours', () => {
    const colors = new Set(
      [PROJECT_A, PROJECT_B, PROJECT_C, PROJECT_D, PROJECT_E, PROJECT_F].map((p) => resolveProjectCharacterColor(p)),
    );
    expect(colors.size).toBe(6);
  });

  it('returns one fixed neutral colour when the project path is absent (undefined)', () => {
    expect(resolveProjectCharacterColor(undefined)).toBe(resolveProjectCharacterColor(undefined));
  });

  // Adversarial twin: an unresolved project must never collide with a real, named project's
  // colour.
  it('does not invent a real project colour for an absent project path', () => {
    expect(resolveProjectCharacterColor(undefined)).not.toBe(resolveProjectCharacterColor(PROJECT_A));
  });

  it('treats a blank (whitespace-only) path the same as absent', () => {
    expect(resolveProjectCharacterColor('   ')).toBe(resolveProjectCharacterColor(undefined));
  });

  // Structural non-collision: sample a wide spread of synthetic paths (enough to almost certainly
  // hit every palette bucket at least once) and confirm the neutral colour never shows up among
  // them — proves the neutral is deliberately kept outside the hashed palette, not a lucky miss.
  it('never resolves the neutral colour from a real project path (structural non-collision)', () => {
    const sample = Array.from({ length: 200 }, (_, i) => `/synthetic/project-${i}`);
    const neutral = resolveProjectCharacterColor(undefined);
    expect(sample.some((p) => resolveProjectCharacterColor(p) === neutral)).toBe(false);
  });

  // The orchestrator's cape / desk accent strip colour is a fixed ROLE marker
  // (`ORCHESTRATOR_ACCENT_COLOR` in character-pose.ts) — a project's own body colour must never
  // be able to land on that exact value and be mistaken for it.
  it('never resolves to the fixed harness accent colour used for the orchestrator cape', () => {
    const sample = Array.from({ length: 200 }, (_, i) => `/synthetic/project-${i}`);
    expect(sample.some((p) => resolveProjectCharacterColor(p) === HARNESS_ACCENT_COLOR)).toBe(false);
    expect(resolveProjectCharacterColor(undefined)).not.toBe(HARNESS_ACCENT_COLOR);
  });

  // Readability: every palette colour (and the neutral) must read clearly against the office's
  // dark ground — floor 0x24242e, back wall 0x1a1a22 (ui/scene/scenery/office-scenery.ts).
  it('keeps every resolved colour bright enough to read against the dark office ground', () => {
    const FLOOR_COLOR = 0x24242e;
    const WALL_COLOR = 0x1a1a22;
    const relativeLuminance = (hex: number): number => {
      const r = (hex >> 16) & 0xff;
      const g = (hex >> 8) & 0xff;
      const b = hex & 0xff;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const floorLuminance = relativeLuminance(FLOOR_COLOR);
    const wallLuminance = relativeLuminance(WALL_COLOR);

    const sample = Array.from({ length: 40 }, (_, i) => `/synthetic/project-${i}`);
    for (const projectPath of [...sample, undefined]) {
      const luminance = relativeLuminance(resolveProjectCharacterColor(projectPath));
      expect(luminance).toBeGreaterThan(floorLuminance * 2);
      expect(luminance).toBeGreaterThan(wallLuminance * 2);
    }
  });
});
