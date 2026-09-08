# Harness Log Ingestion Specification

## Purpose

Locate, tail, and parse the on-disk session stores of four harnesses (Claude Code, Codex,
OpenCode, Antigravity) as a passive, read-only source of truth. No adapter writes to, mutates,
or deletes any harness-owned file.

## Requirements

### Requirement: Claude Code Session Discovery

The system MUST locate Claude Code sessions at `~/.claude/projects/<slug>/<session-id>.jsonl`
and subagent transcripts at `~/.claude/projects/<slug>/<session-id>/subagents/agent-<agentId>.jsonl`.
The system MUST correlate parent and child sessions using `toolUseResult.agentId` and MUST NOT
depend on `attributionAgent` for correctness, since it is an undocumented display hint only.

#### Scenario: Subagent correlates to its parent

- GIVEN a parent session file recorded a launch with `toolUseResult.agentId: "abc123"`
- WHEN the adapter reads `agent-abc123.jsonl` under that parent's `subagents/` directory
- THEN the adapter emits a `parent` event linking child session `abc123` to the parent session ID
- AND this link does not depend on any `attributionAgent` field being present

#### Scenario: attributionAgent absent does not block correlation

- GIVEN a sidechain record has `isSidechain: true`, `agentId: "abc123"`, and no `attributionAgent` field
- WHEN the adapter parses the record
- THEN parent/child correlation succeeds via `agentId` alone
- AND the worker label falls back to a deterministic default, never failing the correlation

### Requirement: Codex Session Discovery and Record Families

The system MUST locate Codex sessions at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
and MUST parse the record families `session_meta`, `event_msg`, `response_item`, `turn_context`,
`world_state`, and `compacted`.

#### Scenario: Session file located by date partition

- GIVEN a Codex rollout file exists at `~/.codex/sessions/2026/08/23/rollout-2026-08-23T12-59-40-01a02fc7-....jsonl`
- WHEN the adapter scans the date-partitioned directory tree
- THEN it discovers the file without requiring a flat/unpartitioned layout

### Requirement: OpenCode Session Access via SQLite Only

The system MUST read OpenCode sessions exclusively from `~/.local/share/opencode/opencode.db`.
The system MUST NOT rely on `storage/` for session data, since no session data exists there
since the v1.2 SQLite migration.

#### Scenario: storage/ yields no session data

- GIVEN `~/.local/share/opencode/storage/` contains only plugin-local UI blobs
- WHEN the adapter starts
- THEN it does not attempt to read session state from `storage/`
- AND it opens `opencode.db` as the sole session source

### Requirement: OpenCode Read-Only Access Invariants

The system MUST open `opencode.db` read-only, MUST NOT write to it, MUST NOT checkpoint the WAL,
and MUST NOT delete `-wal`/`-shm` files. The system MUST treat `SQLITE_BUSY` as a backoff signal,
not an error.

#### Scenario: SQLITE_BUSY triggers backoff, not failure

- GIVEN a query against `opencode.db` returns `SQLITE_BUSY` because the harness holds a write lock
- WHEN the adapter's polling loop receives this result
- THEN it retries after a backoff interval
- AND it does not surface this as an adapter failure or crash

#### Scenario: No WAL side-file deletion

- GIVEN `opencode.db-wal` and `opencode.db-shm` exist alongside the database
- WHEN the adapter opens and later closes its connection
- THEN neither side file is deleted or truncated by the adapter

### Requirement: OpenCode Schema-Drift Degradation

The system MUST probe expected tables and columns at startup and MUST degrade to a
disabled-with-stated-reason state rather than crash when the schema does not match expectations.

#### Scenario: Missing expected column degrades gracefully

- GIVEN a simulated schema drift removes the `session.agent` column
- WHEN the adapter probes the schema at startup
- THEN it disables the OpenCode adapter and reports a specific reason
- AND the other three adapters continue operating unaffected

### Requirement: Antigravity CLI Session Discovery

The system MUST locate Antigravity CLI sessions at
`~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl` and
`transcript_full.jsonl`, and MUST also be aware of `chunks/transcript/*.jsonl` and
`chunks/transcript_full/*.jsonl` mirrors when selecting what to tail.

#### Scenario: transcript and transcript_full both discovered

- GIVEN a CLI conversation directory contains both `transcript.jsonl` and `transcript_full.jsonl`
- WHEN the adapter indexes that conversation
- THEN it records both files as candidate sources for that session

### Requirement: Antigravity IDE Root Separation

The system MUST treat `~/.gemini/antigravity-ide/brain/<uuid>/...` as a separate, read-only root,
distinct in format from the CLI root, and MUST NEVER attempt to launch an Antigravity IDE session.

#### Scenario: IDE sessions render read-only

- GIVEN an Antigravity IDE conversation directory
- WHEN the adapter surfaces this session in the normalized event stream
- THEN no launch affordance is offered for it
- AND the session is marked as ingestion-only

### Requirement: Global No-Write Invariant

The system MUST NOT write to any harness config file, hook file, database, or transcript, across
all four adapters.

#### Scenario: Adapter startup performs zero writes

- GIVEN any of the four adapters starts and reads its target session store
- WHEN the read completes
- THEN no file under `~/.claude/`, `~/.codex/`, `~/.local/share/opencode/`, or `~/.gemini/` has
  been modified, created, or deleted by the adapter
