import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Contract: Dependency direction (design.md) — domain/ must never import adapters/ or ui/.
// Task 1.4 (RED): prove a deliberate domain -> adapters import fails the dependency-cruiser build.
// Task 1.5 (GREEN): prove the same rule set stays clean against non-violating code, i.e. it does
// not false-positive and genuinely gates the CI script (`npm run lint:deps`).

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

describe('dependency-cruiser domain boundary rule', () => {
  it('fails the build on a deliberate domain -> adapters import', () => {
    const result = runDependencyCruiser(path.join(here, 'fixture-violation'));

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('domain-no-adapters');
  });

  it('reports zero violations for code that respects the boundary', () => {
    const result = runDependencyCruiser(path.join(here, 'fixture-clean'));

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('no dependency violations found');
  });
});
