import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Design constraint: src/mcp/ reaches the visualizer over HTTP rather than importing another
// adapter, which is what keeps office_launch a genuine proxy (the Zero-Injection denylist and the
// /launch validation stay behind their own route) and office_snapshot a reader of the real SSE
// frame. Mirrors the existing domain-boundary/pixi-boundary/launcher-boundary rule/test pattern.

const here = path.dirname(fileURLToPath(import.meta.url));
const depcruiseBin = path.resolve(here, '../../node_modules/.bin/depcruise');
const ruleSetConfig = path.resolve(here, '../../.dependency-cruiser.cjs');

function runDependencyCruiser(fixtureDir: string): { exitCode: number; output: string } {
  try {
    const output = execFileSync(depcruiseBin, ['src', '--config', ruleSetConfig], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    return { exitCode: 0, output };
  } catch (error) {
    const execError = error as { status: number; stdout: string };
    return { exitCode: execError.status, output: execError.stdout };
  }
}

describe('dependency-cruiser mcp no-adapters rule', () => {
  it('fails the build on a deliberate mcp -> adapter import', () => {
    const result = runDependencyCruiser(path.join(here, 'fixture-mcp-violation'));

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('mcp-no-adapters');
  });

  it('reports zero violations when src/mcp/ imports no adapter file', () => {
    const result = runDependencyCruiser(path.join(here, 'fixture-mcp-clean'));

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('no dependency violations found');
  });
});
