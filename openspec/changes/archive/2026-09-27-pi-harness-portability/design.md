# Design: Pi Harness Portability

## D1 — Pi is two sources behind one `ActivitySource`

Every other harness maps one store to one `ActivitySource`. Pi has two disjoint stores that
describe two different populations:

- **Orchestrators** live in `~/.pi/agent/sessions/<encoded-cwd>/<iso-ts>_<uuid>.jsonl`. These are
  JSONL transcripts, tailed by byte offset, exactly like Claude Code and Codex.
- **Subagents** live in the presence registry, `~/.pi/agent/gentle-agents/presence/`. These are
  *snapshots*, not append-only logs: `activity.json` is rewritten atomically on every change, with
  a monotonically increasing `generation`.

`PiActivitySource` owns the transcripts. `PiPresenceSource` owns the registry. Both implement
`ActivitySource`, and `src/server.ts` registers both under `harness: 'pi'`. The port needs no
change: an `ActivitySource` was never promised to be one-store-per-harness.

**Why not fold the registry into the transcript adapter?** Because the two have incompatible
checkpoint currencies. A transcript checkpoints on `{offset, size, inode}`; a snapshot registry
checkpoints on `generation` per `(sessionHash, incarnation)`. Merging them would force one adapter
to produce two checkpoint kinds from one `open()`, which the port explicitly models as a per-source
choice (`ByteOffsetCheckpoint` vs `SeqCheckpoint`).

### New checkpoint kind

```ts
export interface GenerationCheckpoint {
  kind: 'generation';
  /** Last published activity generation, keyed by `<sessionHash>.<incarnation>`. */
  byActivation: Record<string, number>;
  /** Last published thread `version` per `<sessionHash>.<incarnation>.<taskId>`. */
  threadByTask?: Record<string, number>;
}
```

`generation` decides *when* a registry file has new content; the per-task `thread.version` decides
*which* tasks changed. This is the same two-currency split `SeqCheckpoint` already documents for
OpenCode (`seq` decides when to wake, `part.time_updated` decides which rows become events), so it
is a pattern the port already contains rather than a new concept.

## D2 — Correlation by hash, never by heuristic

`header.sessionHash === sha256(parentSessionId)` (`orchestrator-presence.ts`, `PresencePublisher`
constructor). The transcript filename's trailing UUID *is* that `sessionId`, confirmed against the
`session` record's own `id` field.

So `PiPresenceSource` emits, for every task it sees:

```
parent(parentSessionKey = `pi:${sessionId}`, childSessionKey = `pi:task:${taskId}`)
```

where `sessionId` is recovered by hashing each *known* Pi session id and matching the hash — a
`Map<sha256, sessionId>` maintained by the transcript adapter's discovery and shared through a
small read-only lookup port. sha256 is one-way, so the join direction is forced: hash the known
ids, never invert the hash.

**When the parent is unknown** (its transcript is outside the active window, or discovery has not
reached it yet), the task is still published. `AgentTree`'s existing `pending` list holds the child
for `orphanGraceMs` and promotes it to a root node if the parent never arrives. No event is
dropped, and no parent is invented. `header.label` (the project name, e.g. `pixel-agents`) is
published as the orphan's `projectPath` hint only when it resolves to an existing absolute path;
otherwise it stays absent, because a bare label is not a path.

## D3 — `AgentRole` is decided by path, not by content

| Path root | Role |
| --- | --- |
| `~/.pi/agent/sessions/` | `orchestrator` |
| `~/.pi/agent/gentle-agents/presence/` (a task) | `subagent` |
| `~/.pi/agent/gentle-agents/sessions/` | `subagent` — **not read by this change** |

Children are spawned with `--session-dir <gentle-agents/sessions>` (`agents-runner.ts:283`), so a
subagent transcript can never appear under the orchestrator root. The transcript adapter therefore
never has to classify: everything it discovers is an orchestrator, by construction.

This is the structural guarantee that prevents the duplicate-worker defect: the two populations
have disjoint key spaces (`pi:<uuid>` vs `pi:task:<id>`) sourced from disjoint directories.

## D4 — Reading the registry safely

`PiPresenceSource` reproduces `orchestrator-presence.ts`'s reader discipline rather than trusting
the filesystem:

1. `lstat` the candidate, reject anything that is not a regular file with `nlink === 1`.
2. Reject files larger than the limit (`16 KiB` header, `16 MiB` activity).
3. Open with `O_NOFOLLOW`, re-`fstat` the descriptor, and reject if `dev`/`ino` moved between the
   `lstat` and the open — that is an atomic replacement mid-read.
4. Validate the header's full field set, and require the filename to equal
   `${sessionHash}.${incarnation}.header.json` for the header it claims to be.
5. Verify `sha256(activityBytes) === header.digest` and `activity.generation === header.generation`.

Any failure is a **skip with a counted reason**, never a throw — the same contract as
`parseCodexLine` returning `null`. `probe()` returns `ready` even when the registry directory does
not exist, because Pi creates it lazily on the first subagent run.

`header.unavailable === 'activity-too-large'` is honoured: the source then publishes only the
header's `counts` as a `stats` event and emits no per-task events, rather than guessing.

### Liveness

`header.heartbeat` is refreshed every 5 s and consumers treat `now - heartbeat <= 15_000` as
`recent`. A non-recent activation is **not** evicted by this source; it stops publishing, and the
existing `SessionLifecycleCoordinator` ages its workers out through the same idle/eviction path
every harness uses. Two clocks deciding eviction is exactly the bug class that produced stale
agents on the floor before.

## D5 — `SessionLifecycle`: a closed union the compiler owns

`SessionActivity` (`'working' | 'idle'`) stays exactly as it is — it is the *liveness projection*
the `SessionLifecycleCoordinator` owns, and nothing else may set it. Pi's task status is a
different fact: what the orchestrator's scheduler says about this task.

```ts
export const SESSION_LIFECYCLES = [
  'running', 'queued', 'waiting', 'completed', 'failed', 'cancelled', 'timed_out',
] as const;
export type SessionLifecycle = (typeof SESSION_LIFECYCLES)[number];
```

Derived from the `const` array so the guard and the type cannot drift, matching `EVENT_KINDS`.
Carried as an optional `lifecycle` field on `status` events. A harness that knows nothing about
lifecycle simply never sets it, and every consumer treats absent as "no claim", never as
`'running'`.

The mapping to what the office draws:

| `lifecycle` | Office meaning |
| --- | --- |
| `running` | works at a desk (today's `working`) |
| `queued` | present but not yet seated — waits, does not type |
| `waiting` | seated, blocked on an answer — idle posture, distinct flag |
| `completed` | normal end; existing `session_end` path |
| `failed`, `timed_out` | ends flagged, so a failure is visible rather than silent |
| `cancelled` | ends unflagged |

## D6 — Events emitted per task

For one task, per registry read:

- first sighting → `session_start` (with `agentProfile{role:'subagent', agentType: task.agent, model: task.model, task: task.label}`) and `parent`
- `status` when `task.status` changes, carrying `lifecycle`
- for each new `thread` item with `kind === 'tool'`: `tool_start` when `running === true`,
  `tool_end` when it flips to `false` (and `reason` set when `isError`)
- terminal `status` → `session_end`

`task.lastActivityAt` is published as the event `at`, so aging uses Pi's own activity clock rather
than the moment our scan happened to run — the same rule `SessionRef.lastActivityAt` already
documents.

## D7 — Launching Pi

`HARNESS_BINARY.pi = 'pi'` with an empty `DEFAULT_HARNESS_TEMPLATES.pi`. Nothing else changes: the
Zero-Injection Spawn Invariant holds by the same construction as the other four, and the existing
poisoned-template test covers the new member automatically because it iterates the record.

## Open questions deliberately left closed

- **Presence `thread` items are read but only tool items are used.** `text`/`thinking` items are
  parsed and discarded here; using them is the deferred interactive panel's job.
- **No replay of `gentle-agents/tasks/`.** Historical task files would populate the floor with dead
  agents at startup, which is the opposite of what the active window exists to prevent.
