/**
 * Project character colour — "Different projects get visibly different character colours ... a
 * project's agents share that colour". Same shape as `model-accent.ts`: a deterministic hash of
 * the string into a fixed palette TABLE, never an `if (projectPath === ...)` chain, plus one fixed
 * neutral colour for the absent/blank case, deliberately outside the palette so it can never
 * collide with a real project's colour.
 *
 * Palette chosen to read clearly as CHARACTER BODY colours against the office's dark ground (the
 * floor `0x24242e` and back wall `0x1a1a22`, `ui/scene/scenery/office-scenery.ts`) and to stay
 * clear of the fixed harness accent `0xffd166` (`character-pose.ts`'s `ORCHESTRATOR_ACCENT_COLOR`,
 * also used for the desk accent strip) — that colour is a ROLE marker (the orchestrator's cape)
 * and must never be mistaken for a project's own body colour.
 */
const PROJECT_PALETTE = [
  0x5da9e9, // sky blue
  0x76c893, // sage green
  0xe07a5f, // terracotta
  0xb185db, // lavender
  0xf2c14e, // amber
  0x4fd1c5, // teal
  0xef6f6c, // coral
  0x9fd356, // lime
  0x7ea8be, // slate blue
  0xd88fb9, // orchid pink
] as const;

/** One fixed neutral colour for a worker with no known project (or a blank one) — never invented
 * from other data, and deliberately outside the palette above so it can never collide with a real
 * project's colour. */
const DEFAULT_PROJECT_COLOR = 0x6b7280;

function hashProjectPath(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function resolveProjectCharacterColor(projectPath?: string): number {
  if (!projectPath || projectPath.trim().length === 0) return DEFAULT_PROJECT_COLOR;
  return PROJECT_PALETTE[hashProjectPath(projectPath) % PROJECT_PALETTE.length]!;
}
