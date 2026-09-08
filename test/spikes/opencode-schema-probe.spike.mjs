#!/usr/bin/env node
// THROWAWAY SPIKE (tasks.md 4.3) — retires OpenCode implementation risk early (slice 1a),
// discard after slice 3 (the real OpenCode adapter) lands. Run manually:
//   node test/spikes/opencode-schema-probe.spike.mjs
//
// Safety: copies opencode.db (plus its -wal/-shm sidecars, so no uncommitted WAL frame is
// lost) to a scratch directory and opens ONLY the copy, read-only. NEVER opens the live
// ~/.local/share/opencode/opencode.db, because a running OpenCode process can hold WAL locks
// on it. Deliberately does NOT use `immutable=1` (design.md D4): that flag skips uncommitted
// WAL frames and would silently report stale state as live — exactly the failure mode this
// spike exists to avoid ever shipping.
//
// Verdict on this machine (Node v22.23.1, 2026-09-06): `node:sqlite`'s `DatabaseSync` opens
// the copy unflagged (only an ExperimentalWarning) and the live schema matches design.md's
// expected `event(aggregate_id, seq, type, data)` shape exactly — no new native dependency
// (e.g. better-sqlite3) is required for slice 3.
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sourcePath = join(process.env.HOME ?? '', '.local/share/opencode/opencode.db');
const scratchDir = mkdtempSync(join(tmpdir(), 'opencode-schema-probe-'));
const copyPath = join(scratchDir, 'opencode-copy.db');

copyFileSync(sourcePath, copyPath);
for (const sidecar of ['-wal', '-shm']) {
  if (existsSync(sourcePath + sidecar)) copyFileSync(sourcePath + sidecar, copyPath + sidecar);
}

const db = new DatabaseSync(copyPath, { readOnly: true });

const columns = db.prepare('PRAGMA table_info(event)').all();
const required = ['aggregate_id', 'seq', 'type', 'data'];
const missing = required.filter((name) => !columns.some((c) => c.name === name));

console.log('event table columns:', columns.map((c) => `${c.name}:${c.type}`).join(', '));
console.log(missing.length === 0 ? 'PASS: all required columns present' : `FAIL: missing ${missing.join(', ')}`);

const sample = db.prepare('SELECT aggregate_id, seq, type FROM event ORDER BY seq DESC LIMIT 3').all();
console.log('most recent event rows:', JSON.stringify(sample));

db.close();
