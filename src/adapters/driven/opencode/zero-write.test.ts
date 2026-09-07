/**
 * OpenCode Session Access via SQLite Only (tasks.md 16.6; spec: "storage/ yields no session
 * data" / "OpenCode Session Access via SQLite Only"). Since OpenCode's v1.2 SQLite migration,
 * `~/.local/share/opencode/storage/` holds only plugin-local UI blobs — no session data — so
 * this adapter's production modules must never reference it as a session-data source.
 *
 * A behavioral "snapshot before/after" proof (the pattern the JSONL adapters use in their own
 * `zero-write.test.ts`) does not apply cleanly here: `node:sqlite`'s file access happens inside
 * native code invisible to JS-level mocking, and mtime-equality proves "did not write", not "did
 * not read". The actually-applicable guard is architectural: none of this adapter's exported
 * functions accepts a directory root to glob under (unlike the three JSONL adapters' `discover`
 * modules) — they only ever take a single `opencode.db` file path. This test makes that
 * structural guarantee explicit and mutation-provable: it scans every production `.ts` file in
 * this directory (never `*.test.ts`) for the literal substring `storage`, asserting the file set
 * is non-trivial FIRST (so the assertion cannot pass merely because no files exist yet).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const MINIMUM_EXPECTED_PRODUCTION_FILES = 4; // db.ts, schema-probe.ts, poll.ts, parse.ts, memory-write-detector.ts

function listProductionSourceFiles(): string[] {
  return readdirSync(ADAPTER_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(ADAPTER_DIR, name));
}

describe('OpenCode Session Access via SQLite Only (tasks.md 16.6)', () => {
  it('the adapter is built from real production files (guards against a vacuously-true scan below)', () => {
    const files = listProductionSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_EXPECTED_PRODUCTION_FILES);
  });

  it('no production module in this adapter references storage/ as a session-data source', () => {
    const files = listProductionSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_EXPECTED_PRODUCTION_FILES);

    const offenders = files.filter((filePath) => /\bstorage[/'"`]/.test(readFileSync(filePath, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
