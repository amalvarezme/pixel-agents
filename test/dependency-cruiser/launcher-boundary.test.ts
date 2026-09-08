import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Design constraint (design.md "Subsystem Separation from Ingestion", tasks.md 26.3): the
// launcher module must have NO import edge to any ingestion adapter's tailer/parser file, even
// though both publish onto the same normalized event bus. Mirrors the existing domain-boundary/
// pixi-boundary rule/test pattern.

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

describe('dependency-cruiser launcher subsystem-separation rule', () => {
  it('fails the build on a deliberate launcher -> ingestion-adapter import', () => {
    const result = runDependencyCruiser(path.join(here, 'fixture-launcher-violation'));

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('launcher-no-ingestion-adapter-imports');
  });

  it('reports zero violations when the launcher imports no ingestion adapter file', () => {
    const result = runDependencyCruiser(path.join(here, 'fixture-launcher-clean'));

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('no dependency violations found');
  });
});
