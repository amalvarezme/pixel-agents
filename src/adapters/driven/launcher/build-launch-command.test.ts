/**
 * `buildLaunchCommand` (tasks.md Phase 23, design.md "The Launcher": "Zero-injection,
 * mechanically enforced"). This is success criterion #4 of the whole change: the argv this
 * function returns for a plain launch MUST be byte-identical to what a user would type manually.
 *
 * Every assertion here compares the COMPLETE argv array by deep equality, never membership —
 * a test asserting only "argv contains the binary" would pass whether or not an extra flag was
 * silently injected alongside it.
 */
import { describe, expect, it } from 'vitest';
import { buildLaunchCommand, buildLaunchEnv, DEFAULT_HARNESS_TEMPLATES, HARNESS_BINARY } from './build-launch-command';
import type { HarnessId } from '../../../domain/events/types';

describe('buildLaunchCommand — argv byte-identity (Threat Matrix case a / success criterion #4)', () => {
  it('returns argv byte-identical to a manually-typed "claude" launch with no extra flags', () => {
    // GIVEN a user would manually run `claude` with no extra flags in a given directory
    const manuallyTypedCommandLine = 'claude'.split(' ');

    // WHEN the launcher builds the argv for that same launch
    const argv = buildLaunchCommand({ harness: 'claude-code', cwd: '/Users/dev/project', args: [] });

    // THEN the resulting argv is byte-identical to the manual invocation
    expect(argv).toEqual(manuallyTypedCommandLine);
    expect(argv).toEqual(['claude']);
  });

  it('appends the user-supplied free arguments verbatim, in order, after the binary (triangulation: a non-trivial argv)', () => {
    const manuallyTypedCommandLine = 'claude --resume abc123'.split(' ');

    const argv = buildLaunchCommand({ harness: 'claude-code', cwd: '/Users/dev/project', args: ['--resume', 'abc123'] });

    expect(argv).toEqual(manuallyTypedCommandLine);
  });

  it('resolves the correct binary name per harness (triangulation: a different code path)', () => {
    expect(buildLaunchCommand({ harness: 'codex', cwd: '.', args: [] })).toEqual(['codex']);
    expect(buildLaunchCommand({ harness: 'opencode', cwd: '.', args: [] })).toEqual(['opencode']);
    expect(buildLaunchCommand({ harness: 'antigravity', cwd: '.', args: [] })).toEqual(['agy']);
  });

  it('exposes the harness->binary map used by both the argv builder and the spawn adapter', () => {
    expect(HARNESS_BINARY).toEqual({
      'claude-code': 'claude',
      codex: 'codex',
      opencode: 'opencode',
      antigravity: 'agy',
    });
  });

  it('the real default template for every harness is empty — no forced flags are ever added', () => {
    expect(DEFAULT_HARNESS_TEMPLATES).toEqual({
      'claude-code': [],
      codex: [],
      opencode: [],
      antigravity: [],
    });
  });
});

describe('buildLaunchCommand — injection guard (Threat Matrix case b, Zero-Injection Spawn Invariant)', () => {
  const poisonedTemplates = (flag: string): Record<HarnessId, readonly string[]> => ({
    'claude-code': [flag],
    codex: [],
    opencode: [],
    antigravity: [],
  });

  it.each(['--append-system-prompt', '--system-prompt', '--settings', '--config'])(
    'throws if the launcher\'s OWN template (never user args) would inject "%s"',
    (flag) => {
      expect(() =>
        buildLaunchCommand(
          { harness: 'claude-code', cwd: '.', args: [] },
          { templates: poisonedTemplates(flag) },
        ),
      ).toThrow(/Zero-Injection Spawn Invariant/);
    },
  );

  it('adversarial near-miss: a template containing a SAFE flag (not on the denylist) never throws', () => {
    // Sanity check that the guard is not just "any non-empty template throws" — it targets the
    // exact denylisted flags, so a harmless flag in the same position must still succeed.
    expect(() =>
      buildLaunchCommand({ harness: 'claude-code', cwd: '.', args: [] }, { templates: poisonedTemplates('--verbose') }),
    ).not.toThrow();
    expect(
      buildLaunchCommand({ harness: 'claude-code', cwd: '.', args: [] }, { templates: poisonedTemplates('--verbose') }),
    ).toEqual(['claude', '--verbose']);
  });

  it('never rejects a denylisted flag when it comes from the user\'s OWN free arguments — that is the user\'s explicit choice, not injection', () => {
    const argv = buildLaunchCommand({ harness: 'claude-code', cwd: '.', args: ['--settings', '/tmp/my-settings.json'] });

    // Byte-identical to what the user typed: the guard never touches spec.args.
    expect(argv).toEqual(['claude', '--settings', '/tmp/my-settings.json']);
  });
});

describe('buildLaunchCommand — literal argv element, never shell-interpreted (Threat Matrix case c)', () => {
  it('passes a destructive shell-metacharacter payload as ONE literal argv element, unmodified', () => {
    const destructivePayload = '; rm -rf /';

    const argv = buildLaunchCommand({ harness: 'claude-code', cwd: '.', args: ['--message', destructivePayload] });

    expect(argv).toEqual(['claude', '--message', '; rm -rf /']);
    expect(argv).toHaveLength(3);
    expect(argv[2]).toBe(destructivePayload);
  });
});

describe('buildLaunchEnv — internal env vars stripped, process.env otherwise passed through unchanged (task 23.6)', () => {
  it('strips this process\'s own internal env vars', () => {
    const env = buildLaunchEnv({
      PORT: '4317',
      CLAUDE_HOME: '/Users/dev/.claude',
      CODEX_HOME: '/Users/dev/.codex',
      GEMINI_HOME: '/Users/dev/.gemini',
      OPENCODE_DB_PATH: '/Users/dev/.local/share/opencode/opencode.db',
      CLAUDE_CODE_ENABLED: 'false',
      CODEX_ENABLED: 'false',
      ANTIGRAVITY_ENABLED: 'false',
      OPENCODE_ENABLED: 'false',
      HOME: '/Users/dev',
      PATH: '/usr/bin:/bin',
    });

    expect(env).toEqual({ HOME: '/Users/dev', PATH: '/usr/bin:/bin' });
  });

  it('passes every other var through byte-identical, including one that only resembles an internal name (adversarial near-miss)', () => {
    const env = buildLaunchEnv({ HOME: '/Users/dev', PORTABLE_FLAG: 'yes', MY_OPENCODE_DB_PATH_OVERRIDE: 'x' });

    expect(env).toEqual({ HOME: '/Users/dev', PORTABLE_FLAG: 'yes', MY_OPENCODE_DB_PATH_OVERRIDE: 'x' });
  });
});
