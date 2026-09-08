/**
 * argv builder (tasks.md Phase 23, design.md "The Launcher": "Zero-injection, mechanically
 * enforced"). `buildLaunchCommand(spec) -> argv[]` is a PURE function: a per-harness allowlisted
 * template plus the user's own free arguments, nothing else. Its byte-identity test against a
 * manually-typed command line is success criterion #4 of the whole change.
 *
 * The Zero-Injection Spawn Invariant is enforced structurally, not by scrubbing user input: the
 * allowlisted template is the ONLY thing this module controls, it is a hard-coded constant, and
 * `assertTemplateNeverInjectsDenylistedFlags` proves — by construction, and by a test that
 * deliberately poisons the template through the injectable `options.templates` seam — that it can
 * never carry `--append-system-prompt`/`--system-prompt`/`--settings`/`--config`. Whatever the
 * user types into their own free-argument field is never inspected, stripped, or rejected: it is
 * the user's explicit choice, not injection, and altering it would break byte-identity (success
 * criterion #4) for the exact case the Zero-Injection Spawn Invariant exists to protect.
 */
import type { HarnessId } from '../../../domain/events/types';
import type { LaunchSpec } from '../../../ports/session-launcher.port';

export const HARNESS_BINARY: Record<HarnessId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  antigravity: 'agy',
};

/**
 * Real templates for every supported harness are — and must remain — empty. There is no feature
 * today that adds a forced flag to any harness launch. Exported so a test can prove the injection
 * guard actually fires against a deliberately poisoned override, without ever touching this real
 * constant.
 */
export const DEFAULT_HARNESS_TEMPLATES: Record<HarnessId, readonly string[]> = {
  'claude-code': [],
  codex: [],
  opencode: [],
  antigravity: [],
};

/** Flags the launcher's OWN template must never inject (spec: Zero-Injection Spawn Invariant). */
export const INJECTION_DENYLIST = ['--append-system-prompt', '--system-prompt', '--settings', '--config'] as const;

export interface BuildLaunchCommandOptions {
  /**
   * Test-only seam. Production wiring never overrides this — it always applies
   * `DEFAULT_HARNESS_TEMPLATES` — so the only way a denylisted flag ever reaches this function's
   * own template is a test proving the guard fires (mutation-tested: deleting the guard call lets
   * a poisoned template through undetected).
   */
  templates?: Record<HarnessId, readonly string[]>;
}

function assertTemplateNeverInjectsDenylistedFlags(harness: HarnessId, template: readonly string[]): void {
  const injected = template.find((flag) => (INJECTION_DENYLIST as readonly string[]).includes(flag));
  if (injected) {
    throw new Error(
      `buildLaunchCommand: the "${harness}" allowlisted template must never inject "${injected}" ` +
        '(Zero-Injection Spawn Invariant, Threat Matrix case b)',
    );
  }
}

/**
 * Per-harness allowlisted template + the user's own free arguments. `spec.args` is never
 * inspected: it is exactly what the user typed, and byte-identity requires it to survive
 * unchanged, in order, as literal argv elements (Threat Matrix case c: never shell-interpreted).
 */
export function buildLaunchCommand(spec: LaunchSpec, options: BuildLaunchCommandOptions = {}): string[] {
  const templates = options.templates ?? DEFAULT_HARNESS_TEMPLATES;
  const template = templates[spec.harness];
  assertTemplateNeverInjectsDenylistedFlags(spec.harness, template);
  return [HARNESS_BINARY[spec.harness], ...template, ...spec.args];
}

/**
 * This process's OWN configuration env vars (`src/server.ts`) — never meant to leak into a
 * spawned harness CLI's environment, since e.g. `CLAUDE_HOME`/`PORT` could collide with or
 * confuse that CLI's own env-based configuration (task 23.6, design.md: "strips our internal env
 * vars while passing `process.env` through otherwise unchanged").
 */
const INTERNAL_ENV_VARS = [
  'PORT',
  'CLAUDE_HOME',
  'CODEX_HOME',
  'GEMINI_HOME',
  'OPENCODE_DB_PATH',
  'CLAUDE_CODE_ENABLED',
  'CODEX_ENABLED',
  'ANTIGRAVITY_ENABLED',
  'OPENCODE_ENABLED',
] as const;

/** Strips this process's own internal env vars; every other entry passes through unchanged. */
export function buildLaunchEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...sourceEnv };
  for (const key of INTERNAL_ENV_VARS) delete env[key];
  return env;
}
