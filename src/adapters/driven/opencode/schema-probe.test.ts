/**
 * OpenCode startup schema probe (tasks.md 16.3, 16.4; design.md "Startup schema probe"; spec:
 * "OpenCode Schema-Drift Degradation"). Uses ONLY the synthetic-db fixture built from the
 * captured DDL, never the live db.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSyntheticOpenCodeDb, dropColumn } from '../../../../test/helpers/opencode-db';
import { probeOpenCodeSchema } from './schema-probe';

describe('probeOpenCodeSchema (tasks.md 16.3)', () => {
  let scratchDir: string;

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  it('reports ready with no degraded capabilities when the full captured schema is present', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-probe-'));
    const db = buildSyntheticOpenCodeDb(join(scratchDir, 'opencode.db'));

    const result = probeOpenCodeSchema(db);

    expect(result).toEqual({ status: 'ready', degradedCapabilities: [] });
    db.close();
  });

  it('reports a degraded-capability flag (not disable) when an optional stats column is missing', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-probe-'));
    const db = buildSyntheticOpenCodeDb(join(scratchDir, 'opencode.db'));
    dropColumn(db, 'session', 'cost');

    const result = probeOpenCodeSchema(db);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.degradedCapabilities).toContain('cost');
    db.close();
  });

  it('degrades to disabled(schema_drift) when a required event column is missing (event.seq)', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-probe-'));
    const db = buildSyntheticOpenCodeDb(join(scratchDir, 'opencode.db'));
    dropColumn(db, 'event', 'seq');

    const result = probeOpenCodeSchema(db);

    expect(result).toEqual({ status: 'disabled', reason: 'schema_drift', detail: 'event.seq missing' });
    db.close();
  });

  it('degrades to disabled(schema_drift) when session.agent is dropped (spec: "Missing expected column degrades gracefully")', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-probe-'));
    const db = buildSyntheticOpenCodeDb(join(scratchDir, 'opencode.db'));
    dropColumn(db, 'session', 'agent');

    const result = probeOpenCodeSchema(db);

    expect(result).toEqual({ status: 'disabled', reason: 'schema_drift', detail: 'session.agent missing' });
    db.close();
  });

  it('near-miss twin: dropping only an unrelated optional column (tokens_input) while agent stays present stays ready', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'opencode-probe-'));
    const db = buildSyntheticOpenCodeDb(join(scratchDir, 'opencode.db'));
    dropColumn(db, 'session', 'tokens_input');

    const result = probeOpenCodeSchema(db);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.degradedCapabilities).toContain('tokens_input');
    db.close();
  });
});
