import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Design constraint (design.md D3, tasks.md 10.3): only `src/ui/scene/pixi/` may import
// `pixi.js` — layout math and the rest of `ui/` must stay canvas-free and testable without a
// browser. This mirrors the existing domain-boundary rule/test pattern (Phase 1).

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

describe('dependency-cruiser pixi boundary rule', () => {
  it('fails the build on a deliberate pixi.js import outside ui/scene/pixi/', () => {
    const result = runDependencyCruiser(path.join(here, 'fixture-pixi-violation'));

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('pixi-only-in-scene-pixi');
  });

  it('reports zero violations when pixi.js is imported only from ui/scene/pixi/', () => {
    const result = runDependencyCruiser(path.join(here, 'fixture-pixi-clean'));

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('no dependency violations found');
  });
});
