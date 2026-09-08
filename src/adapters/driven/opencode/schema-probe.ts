/**
 * OpenCode startup schema probe (tasks.md 16.3; design.md "Startup schema probe"; spec:
 * "OpenCode Schema-Drift Degradation"). Checks `PRAGMA table_info(<table>)` for each required
 * table/column (research-local-evidence.md Q3's captured DDL) and never throws: a missing
 * REQUIRED column degrades to `disabled(reason:'schema_drift')`; a missing OPTIONAL column
 * degrades only a capability flag while the adapter stays `ready`.
 *
 * `session.agent` is classified REQUIRED here, not optional. `design.md`'s "Startup schema
 * probe" table and tasks.md 16.3's own parenthetical both originally grouped `agent` with the
 * optional stats columns — but spec.md's own acceptance scenario ("Missing expected column
 * degrades gracefully") and tasks.md 16.4 both explicitly require dropping `session.agent` to
 * DISABLE the adapter, not merely degrade a capability. This module follows the spec scenario
 * (the acceptance criteria) over the design table's prose, which this change also corrects.
 */
import type { DatabaseSync } from './db';

interface RequiredTableSpec {
  table: string;
  columns: readonly string[];
}

const REQUIRED_TABLES: readonly RequiredTableSpec[] = [
  { table: 'event', columns: ['aggregate_id', 'seq', 'type', 'data'] },
  { table: 'session', columns: ['id', 'parent_id', 'title', 'time_created', 'time_updated', 'agent'] },
  { table: 'message', columns: ['id', 'session_id', 'data'] },
  { table: 'part', columns: ['id', 'message_id', 'session_id', 'data'] },
];

/** Stats columns on `session`: absence degrades label/stats rendering, never disables the adapter. */
const OPTIONAL_SESSION_STATS_COLUMNS = [
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
  'cost',
] as const;

export type SchemaProbeResult =
  | { status: 'ready'; degradedCapabilities: string[] }
  | { status: 'disabled'; reason: 'schema_drift'; detail: string };

function tableColumnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Probes `db` against the captured DDL. Never throws — every check is a defensive lookup. */
export function probeOpenCodeSchema(db: DatabaseSync): SchemaProbeResult {
  for (const spec of REQUIRED_TABLES) {
    const columns = tableColumnNames(db, spec.table);
    for (const column of spec.columns) {
      if (!columns.has(column)) {
        return { status: 'disabled', reason: 'schema_drift', detail: `${spec.table}.${column} missing` };
      }
    }
  }

  const sessionColumns = tableColumnNames(db, 'session');
  const degradedCapabilities = OPTIONAL_SESSION_STATS_COLUMNS.filter((column) => !sessionColumns.has(column));

  return { status: 'ready', degradedCapabilities };
}
