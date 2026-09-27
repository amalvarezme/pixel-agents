# Harness Log Ingestion Specification

## ADDED Requirements

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
