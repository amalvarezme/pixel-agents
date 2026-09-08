/**
 * OpenCode read-only db open (tasks.md 16.1; design.md "Decision: read-only SQLite for OpenCode,
 * never `immutable=1`"; spec: "OpenCode Read-Only Access Invariants").
 *
 * Driver choice: `node:sqlite`'s `DatabaseSync`, NOT `better-sqlite3`. `design.md` line 459 left
 * this pick open, deferred to this slice; it is now resolved — `test/spikes/opencode-schema-
 * probe.spike.mjs` verified on this machine that `DatabaseSync` opens the real schema read-only
 * with no new native dependency required. `better-sqlite3` is intentionally NOT installed.
 *
 * `node:sqlite` is imported via `createRequire` rather than a static `import` because the
 * project's pinned Vite/vite-node version (5.4.21 / vitest 2.1.8) hardcodes an outdated Node
 * builtin-module allowlist that predates `node:sqlite`'s addition, and would otherwise try to
 * resolve it as an npm package named `sqlite` and fail. `require()` bypasses Vite's module graph
 * entirely and lets Node's own module loader resolve the real builtin.
 *
 * Read-only invariants enforced here, matching the Threat Matrix ("Read-only host data" row):
 * - `readOnly: true` on `DatabaseSync` (this project's equivalent of better-sqlite3's
 *   `{readonly:true, fileMustExist:true}` — `DatabaseSync` has no separate `fileMustExist` flag;
 *   a missing path is instead reported as `disabled` below, never a crash).
 * - `PRAGMA query_only = 1` and `PRAGMA busy_timeout = 0` (we own backoff ourselves, `poll.ts`).
 * - `immutable=1` is explicitly FORBIDDEN and never appears anywhere in this module: it would
 *   skip uncommitted WAL frames and silently report stale state as live (design.md D4).
 * - Never checkpoints, never changes `journal_mode`, never deletes `-wal`/`-shm`. A read-only
 *   connection structurally cannot checkpoint — that omission IS the safety property.
 *
 * `-shm` absence is checked on the filesystem BEFORE attempting to open (rather than relying on
 * `DatabaseSync` to throw `SQLITE_CANTOPEN`): experimentally, a same-process readonly open can
 * still succeed even with `-shm` deleted (SQLite manages to still be able to read in some cases,
 * depending on VFS/locking state), which would make a throw-only detection strategy unreliable.
 * The explicit precondition check makes "no -shm while -wal is live" deterministically degrade,
 * regardless of what the underlying library happens to do on a given platform (spec: "OpenCode
 * Schema-Drift Degradation" sibling scenario, Threat Matrix case g).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
export type { DatabaseSync } from 'node:sqlite';

const WAL_SIDECAR_SUFFIX = '-wal';
const SHM_SIDECAR_SUFFIX = '-shm';

export interface OpenCodeDbHandle {
  readonly db: import('node:sqlite').DatabaseSync;
  close(): void;
}

export type OpenCodeDbOpenResult =
  | { status: 'ready'; handle: OpenCodeDbHandle }
  | { status: 'disabled'; reason: 'wal_shm_unavailable'; detail: string };

/**
 * Opens `dbPath` read-only for polling. Never throws: any failure — missing `-shm` sidecar while
 * `-wal` is present, a corrupt file, a missing db, or any other open-time error — degrades to
 * `disabled(reason:'wal_shm_unavailable')` so the caller can retry on an interval rather than
 * crash the process (spec: "OpenCode Schema-Drift Degradation" pattern, applied here to open
 * failures generally).
 */
export function openOpenCodeDbReadOnly(dbPath: string): OpenCodeDbOpenResult {
  const walPath = `${dbPath}${WAL_SIDECAR_SUFFIX}`;
  const shmPath = `${dbPath}${SHM_SIDECAR_SUFFIX}`;
  if (existsSync(walPath) && !existsSync(shmPath)) {
    return {
      status: 'disabled',
      reason: 'wal_shm_unavailable',
      detail: `${shmPath} is missing while ${walPath} is present; refusing to open (never falls back to immutable=1)`,
    };
  }

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = 1');
    db.exec('PRAGMA busy_timeout = 0');
    return { status: 'ready', handle: { db, close: () => db.close() } };
  } catch (error) {
    return {
      status: 'disabled',
      reason: 'wal_shm_unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
