# Harness Log Ingestion Specification

## Purpose

Locate, tail, and parse the on-disk session stores of five harnesses (Claude Code, Codex,
OpenCode, Antigravity, Pi) as a passive, read-only source of truth. No adapter writes to, mutates,
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

### Requirement: Pi Orchestrator Session Discovery

The system MUST locate Pi orchestrator sessions at
`~/.pi/agent/sessions/<encoded-cwd>/<iso-timestamp>_<session-id>.jsonl` and MUST derive the session
id from the filename segment after the first `_`. The system MUST resolve the session's working
directory by reading the `cwd` field of the transcript's own `session` record, and MUST NOT decode
it from the directory name, since that encoding is lossy (`/` and `-` collapse to the same
character).

The system MUST treat every session found under this root as `role: 'orchestrator'`.

#### Scenario: Session id and project resolved from the transcript

- GIVEN a file `~/.pi/agent/sessions/--Users-a-Documents-proj--/2026-09-27T01-15-55-499Z_01a0e06e-d6eb-7018-81fe-cc81a7736e52.jsonl`
- AND its first record is `{"type":"session","version":3,"id":"01a0e06e-d6eb-7018-81fe-cc81a7736e52","cwd":"/Users/a/Documents/proj"}`
- WHEN the adapter discovers it
- THEN the `SessionRef` has `sessionKey` `pi:01a0e06e-d6eb-7018-81fe-cc81a7736e52`
- AND its `cwd` is `/Users/a/Documents/proj`
- AND its `cwd` was NOT derived from the directory name

#### Scenario: Missing session record leaves cwd absent

- GIVEN a Pi transcript whose bounded prefix contains no `session` record
- WHEN the adapter discovers it
- THEN the `SessionRef.cwd` is `null`
- AND no project path is guessed from the directory name

#### Scenario: Directory-name encoding is never inverted

- GIVEN two distinct real directories `/tmp/a-b` and `/tmp/a/b`
- WHEN both produce Pi session directories
- THEN the adapter never attempts to distinguish them by name
- AND each session's project comes only from its own `session` record's `cwd`

### Requirement: Pi Transcript Record Families

The system MUST recognise Pi's transcript record families, discriminated by a top-level `type`:
`session`, `model_change`, `thinking_level_change`, `custom`, and `message`. A `message` record
carries `message.role` of `system`, `user`, `assistant`, or `toolResult`, and an `assistant`
message's `message.content` is an array of parts with `type` of `text`, `thinking`, or `toolCall`.

The system MUST emit `tool_start` for each `toolCall` part and `tool_end` for each `toolResult`
message, correlated by `toolCallId`. The system MUST update the session's live `agentProfile.model`
from `model_change` records and from `message.model` on assistant messages, and MUST NOT default or
invent a model when neither is present.

A malformed line MUST return `null` from the parser and MUST NOT throw.

#### Scenario: Tool call and its result become a start/end pair

- GIVEN an assistant message with `{"type":"toolCall","id":"toolu_01","name":"bash","arguments":{"command":"git log"}}`
- AND a later `toolResult` message with `toolCallId: "toolu_01"` and `toolName: "bash"`
- WHEN the adapter maps both records
- THEN it emits `tool_start` with `toolLabel` `bash` and a bounded `toolDetail` from the command
- AND it emits `tool_end` correlated to the same `toolCallId`

#### Scenario: Live model comes from the transcript, never a default

- GIVEN a transcript with `{"type":"model_change","provider":"claude-bridge","modelId":"claude-opus-5"}`
- WHEN the adapter maps that record
- THEN the session's `agentProfile.model` becomes `claude-opus-5`
- AND a transcript with no `model_change` and no assistant `message.model` leaves `model` absent

#### Scenario: Malformed line is skipped, not fatal

- GIVEN a truncated final line in a Pi transcript
- WHEN the parser reads it
- THEN it returns `null`
- AND the surrounding well-formed lines are still mapped to events

### Requirement: Pi Subagent Presence Registry

The system MUST read Pi subagent state from
`~/.pi/agent/gentle-agents/presence/<sessionHash>.<incarnation>.header.json` and its paired
`.activity.json`, and MUST NOT read subagent transcripts for this purpose.

Every read MUST be bounded (16 KiB header, 16 MiB activity), MUST reject a path that is not a
regular file with a link count of one, MUST open without following symlinks, and MUST reject a file
whose device/inode changed between the stat and the open. The system MUST require the filename to
match the header's own `sessionHash` and `incarnation`, MUST require
`activity.generation === header.generation`, and MUST verify
`sha256(activityBytes) === header.digest`.

Any validation failure MUST be a counted skip and MUST NOT throw or terminate the source.

#### Scenario: Registry absent yields no sessions and stays healthy

- GIVEN `~/.pi/agent/gentle-agents/presence/` does not exist, because no subagent has ever run
- WHEN the source probes and discovers
- THEN `probe()` reports `{ status: 'ready' }`
- AND discovery yields zero sessions
- AND no directory is created

#### Scenario: Digest mismatch is skipped, never published

- GIVEN a header whose `digest` does not match the bytes of its `activity.json`
- WHEN the source reads that activation
- THEN no task event is published for it
- AND the skip is counted with reason `digest-mismatch`
- AND the source continues reading other activations

#### Scenario: Oversized activity degrades to header counts

- GIVEN a header with `unavailable: "activity-too-large"` and `digest: null`
- WHEN the source reads that activation
- THEN it publishes the header's `counts` as a `stats` event
- AND it publishes no per-task events
- AND it does not attempt to read `activity.json`

#### Scenario: Atomic replacement mid-read is rejected

- GIVEN the activity file is atomically replaced between the source's `lstat` and its `open`
- WHEN the source detects the device/inode pair no longer matches
- THEN the read is abandoned as `unsafe-file`
- AND the next scan reads the replacement cleanly

### Requirement: Pi Parent/Child Correlation By Session Hash

The system MUST correlate a Pi subagent task to its orchestrator by matching
`header.sessionHash` against `sha256(sessionId)` of each discovered Pi orchestrator session, and
MUST NOT attempt to invert the hash or infer a parent by any other signal.

The child's `sessionKey` MUST be `pi:task:<task.id>` and the parent's `pi:<sessionId>`. A task whose
parent hash matches no known session MUST still be published, relying on the agent tree's existing
orphan grace to promote it.

#### Scenario: Task links to its orchestrator exactly

- GIVEN a discovered Pi session with id `S` whose `sha256(S)` equals a header's `sessionHash`
- AND that header's activity contains a task with `id: "t1"`
- WHEN the source publishes that task
- THEN it emits a `parent` event linking `pi:task:t1` to `pi:S`
- AND the link required no heuristic, filename proximity, or timing window

#### Scenario: Unknown parent does not drop the subagent

- GIVEN a header whose `sessionHash` matches no discovered Pi session
- WHEN the source publishes its tasks
- THEN each task still produces a `session_start` event
- AND no parent session key is invented
- AND the agent tree promotes it to a root node after the orphan grace elapses

### Requirement: Pi Subagent Project Inheritance

When the parent hash join resolves, the system MUST give a Pi subagent the project path of its
orchestrator by recording each discovered session's own `cwd` beside the `sha256(sessionId)` key and
resolving that `hash -> path` for the matched parent. The subagent's `session_start` MUST carry the
resolved `projectPath`.

The system MUST resolve this join merge-not-erase: a session whose `cwd` cannot be read MUST NOT
erase a path already recorded for that hash. The system MUST NOT publish a subagent's `projectPath`
from `header.label`, which is a project name rather than a path, and therefore MUST leave
`projectPath` absent when no resolvable parent yields a real path rather than guessing one.

A subagent published before its parent becomes resolvable MUST receive the inherited path when it
resolves, and that late registration MUST re-announce the subagent's full identity exactly once.

#### Scenario: Subagent inherits its orchestrator's resolved path

- GIVEN a Pi orchestrator session with id `S` whose transcript `session` record carries `cwd: "/Users/a/Documents/proj"`
- AND a presence header whose `sessionHash` equals `sha256(S)`
- WHEN the source publishes a task from that header
- THEN the task's `session_start` carries `projectPath` `/Users/a/Documents/proj`
- AND the office reports one project for that orchestrator and all of its subagents

#### Scenario: An unresolvable parent leaves the path absent

- GIVEN a presence header whose `sessionHash` matches no discovered Pi session
- WHEN the source publishes its tasks
- THEN each task's `session_start` carries no `projectPath`
- AND no path is derived from the header's `label`

#### Scenario: A failed `cwd` reading does not erase a known path

- GIVEN a hash already resolved to `/Users/a/Documents/proj`
- AND a later scan of that session yields no readable `cwd`
- WHEN the join is refreshed
- THEN the previously resolved path is retained
- AND it is not reset to absent

#### Scenario: A late parent re-announces identity once

- GIVEN a task published while its parent hash was unknown
- WHEN the parent session later becomes resolvable
- THEN the subagent's identity is re-announced with the inherited `projectPath`
- AND it is re-announced once, not on every subsequent scan

### Requirement: Pi Subagent Lifecycle Events

The system MUST publish a `status` event carrying the task's `lifecycle` whenever a task's `status`
changes, using one of `running`, `queued`, `waiting`, `completed`, `failed`, `cancelled`,
`timed_out`. The system MUST publish `tool_start` when a thread item of kind `tool` has
`running: true`, and `tool_end` when that same `callId` is next seen with `running: false`, setting
`reason` when `isError` is true. A terminal status MUST additionally produce `session_end`.

Every published event's `at` MUST be the task's own `lastActivityAt`, never the time the scan ran.

#### Scenario: A queued task is published as queued, not working

- GIVEN a task with `status: "queued"` and `startedAt: null`
- WHEN the source publishes it
- THEN the `status` event carries `lifecycle: 'queued'`
- AND the event does not carry `activity: 'working'`

#### Scenario: A failing tool ends with a reason

- GIVEN a thread item `{kind:'tool', callId:'c1', name:'bash', running:true, isError:false}`
- AND a later read shows `{kind:'tool', callId:'c1', name:'bash', running:false, isError:true}`
- WHEN the source publishes the change
- THEN it emits `tool_end` for `c1`
- AND that event carries a `reason` reflecting the error

#### Scenario: Event time is the task's activity clock

- GIVEN a task with `lastActivityAt` two hours in the past
- WHEN the source discovers and publishes it for the first time
- THEN the `session_start` event's `at` is that `lastActivityAt`
- AND it is not the current time

### Requirement: Pi Zero-Write Guarantee

No Pi adapter MAY create, modify, truncate, rename, or delete any path under `~/.pi/`. The system
MUST open Pi files for reading only and MUST NOT create the presence directory when it is absent.

#### Scenario: A full ingestion cycle mutates nothing

- GIVEN a fixture tree mirroring `~/.pi/agent/sessions/` and `~/.pi/agent/gentle-agents/presence/`
- WHEN discovery, tailing, and presence reading run a full cycle against it
- THEN every file's content, mtime, and inode is unchanged
- AND no new path exists anywhere under the fixture root

### Requirement: Pi memory_write Detection

The system MUST detect Engram observation writes in Pi transcripts from an assistant `toolCall`
part whose `name` identifies a `mem_save` tool, reading `title`, `topic_key`, and `type` from its
`arguments`. The detector MUST be Pi-private, taking Pi's own record type, and MUST emit
`memory_write` alongside — never instead of — the record's `tool_start`.

#### Scenario: mem_save produces both events

- GIVEN an assistant `toolCall` with `name` matching `mem_save` and `arguments.title: "Decision X"`
- WHEN the adapter maps the record
- THEN it emits `tool_start` for that call
- AND it additionally emits `memory_write` with `title: "Decision X"`

#### Scenario: A non-memory tool call produces no memory_write

- GIVEN an assistant `toolCall` with `name: "bash"`
- WHEN the detector inspects it
- THEN it returns `null`
- AND only `tool_start` is emitted

### Requirement: Pi Subagent memory_write From The Presence Registry

A Pi subagent's activity exists only in the presence registry, never in the orchestrator transcript.
The system MUST therefore emit `memory_write` alongside `tool_start` when a registry thread item of
kind `tool` names a `mem_save` tool, and MUST accept both the bare and the MCP-prefixed spelling
through one shared tool-name predicate, shared with the transcript detector, rather than a duplicated
pattern.

Because a registry thread item carries no tool arguments, the emitted `memory_write` MUST leave
`title`, `topicKey`, and `observationType` absent, and MUST NOT fabricate them from the tool name.
The event MUST be emitted exactly once per tool call, gated by the same running-call bookkeeping that
pairs `tool_start` with `tool_end`, and MUST NOT repeat on every scan. This path MUST NOT change the
transcript detector's behaviour.

#### Scenario: A subagent's mem_save docks a file

- GIVEN a task thread item `{kind:'tool', callId:'c1', name:'mem_save', running:true}`
- WHEN the source diffs that thread
- THEN it emits `tool_start` for `c1`
- AND it additionally emits `memory_write` for that subagent's session
- AND folding those events into the office state occupies an archive destination, as any other
  `memory_write` would

#### Scenario: Registry memory_write carries no arguments-derived fields

- GIVEN a `memory_write` emitted from a presence-registry thread item
- WHEN the event is constructed
- THEN `title`, `topicKey`, and `observationType` are all absent
- AND none of them is invented from the tool name

#### Scenario: One call produces one memory_write

- GIVEN a running `mem_save` thread item observed across three consecutive scans
- WHEN the source publishes each scan
- THEN exactly one `memory_write` is emitted for that `callId`
- AND the item's later `running: false` observation still produces its matching `tool_end`

#### Scenario: The MCP-prefixed spelling matches the same predicate

- GIVEN a thread item with `name: "mcp__engram__mem_save"`
- WHEN the source inspects it
- THEN it emits `memory_write` in addition to `tool_start`
- AND it matches the one predicate that also matches `mem_save`

#### Scenario: Other registry tools produce no memory_write

- GIVEN thread items named `bash`, `read`, or `edit`
- WHEN the source diffs that thread
- THEN each emits `tool_start` only
- AND no `memory_write` is emitted
