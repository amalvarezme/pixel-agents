/**
 * Composition-level guard (opencode-activity-source work unit): the checkpoint file this process
 * writes to must never live inside a directory any `ActivitySource` watches — specifically
 * `OPENCODE_DB_PATH`'s directory, since this is the first harness whose watched root is a live
 * SQLite database rather than a read-only JSONL tree (an accidental write there would be far more
 * dangerous than an accidental write into a log directory).
 *
 * `server.ts` calls `void main()` unconditionally at import time (it is the composition root, run
 * via `vite-node`/`node`), so this test never imports it — importing it here would start a real
 * SSE server bound to a real port as a side effect of running the test suite. Instead this is a
 * structural scan of `server.ts`'s own source text, mirroring the established precedent in
 * `opencode/zero-write.test.ts` for guarding an architectural property without executing the
 * module under test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'server.ts');

function readServerSource(): string {
  return readFileSync(SERVER_SOURCE_PATH, 'utf8');
}

function extractConstDeclaration(source: string, name: string): string {
  const match = source.match(new RegExp(`const ${name} = ([^;]+);`));
  const declaration = match?.[1];
  if (!declaration) throw new Error(`expected server.ts to declare \`const ${name} = ...\``);
  return declaration;
}

describe('server.ts checkpoint path (composition-level guard)', () => {
  it('the checkpoint file is guarded against ever resolving inside a watched harness directory', () => {
    const source = readServerSource();
    // Guards against a vacuously-true regex match below: the constant must actually be present.
    expect(source).toContain('const CHECKPOINT_FILE');
    const declaration = extractConstDeclaration(source, 'CHECKPOINT_FILE');

    expect(declaration).toContain('process.cwd()');
    expect(declaration).not.toMatch(/CLAUDE_HOME|CODEX_HOME|GEMINI_HOME|OPENCODE_DB_PATH/);
  });

  it('adversarial near-miss: OPENCODE_DB_PATH itself IS declared from a harness-specific home, unlike CHECKPOINT_FILE', () => {
    const source = readServerSource();
    const declaration = extractConstDeclaration(source, 'OPENCODE_DB_PATH');

    // Proves the regex above is discriminating (harness-home path) vs. non-discriminating
    // (process.cwd()), rather than merely never matching anything.
    expect(declaration).toMatch(/homedir\(\)/);
  });
});
