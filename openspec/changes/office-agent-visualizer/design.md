# Design: Office Agent Visualizer

> SDD phase `sdd-design`. Mirrors Engram topic `sdd/office-agent-visualizer/design`.
> Inputs: `proposal.md`, `research-local-evidence.md` (incl. Antigravity addendum), `exploration.md`.

## Technical Approach

A hexagonal Node/TypeScript service. Four **driven adapters** read harness telemetry read-only and
emit one normalized `AgentEvent` stream through a port. A framework-free **domain** projects that
stream into an `Office` model (workers, lanes, archive). A **driving adapter** publishes the
projection to a browser over SSE, where a PixiJS scene renders it. A fifth subsystem, the
**launcher**, spawns harness CLIs with zero injection and emits its own events onto the same bus —
sharing the bus but no code path with ingestion.

The crux: the four harnesses encode an MCP tool call four incompatible ways, so `memory_write`
detection is **per-adapter and typed on that adapter's own record shape**, never a shared pattern
match. That constraint drives the module boundaries below.

## Module Structure

Screaming/hexagonal. Directory names state the domain; framework names appear only at the leaves.

```
src/
  domain/            zero I/O, zero runtime deps
    events/          AgentEvent union, factories, invariants
    agents/          AgentId, AgentNode, AgentTree, orphan promotion
    sessions/        SessionKey, lifecycle (active|idle|ended)
    office/          Office aggregate: workers, lanes, archive, carry queue
  application/       use cases
    ingest-agent-activity/   publish-office-stream/   launch-agent-session/
  ports/             interfaces owned by the inside
    activity-source.port.ts  session-launcher.port.ts  terminal-backend.port.ts
    event-publisher.port.ts  checkpoint-store.port.ts  clock.port.ts
  adapters/
    driven/  claude-code/ codex/ antigravity/ opencode/ launcher/ checkpoint/
    driving/ http/        (SSE + POST /launch)
  ui/
    scene/       layout/ (pure TS math)  pixi/ (only file importing PixiJS)
    containers/  OfficeContainer — owns SSE subscription + projection state
    components/  atoms | molecules | organisms (atomic design, presentational)
    state/       client-side office projection
  shared/        Result, branded ids, jsonl utilities
test/fixtures/<harness>/   recorded real-log records (true positives + traps)
```

Dependency rule: `adapters → ports → application → domain`. Enforced by a `dependency-cruiser`
rule that fails the build if `domain/` imports `adapters/`, `ui/`, or any third-party runtime
package. This is a build-gated invariant, not a convention.

## Architecture Decisions

### Decision: one `ActivitySource` port, four implementations, adapter-private checkpoints

**Choice**

```ts
type SourceHealth = { status: 'ready' } | { status: 'disabled'; reason: string; detail?: string };

interface ActivitySource {
  readonly harness: HarnessId;              // claude-code | codex | opencode | antigravity
  probe(): Promise<SourceHealth>;           // capability/schema probe — MUST NOT throw
  discover(): AsyncIterable<SessionRef>;
  open(session: SessionRef, from: Checkpoint | null): ActivityStream;
  close(): Promise<void>;
}
interface ActivityStream { events: AsyncIterable<{ event: AgentEvent; checkpoint: Checkpoint }>; stop(): void }

interface MemoryWriteDetector<TRecord> {          // TRecord is the adapter's OWN record type
  readonly harness: HarnessId;
  detect(record: TRecord): MemoryWriteSignal | null;
}
```

`Checkpoint` is an opaque JSON blob the application only stores and hands back:
`{kind:'byte-offset', offset, size, inode}` for JSONL, `{kind:'seq', bySession}` for OpenCode.

**Alternatives considered** A shared normalized `RecordShape` plus one cross-harness pattern
matcher; a plugin manifest with runtime tool-name globs.

**Rationale** The four encodings — single-string `mcp__*engram*__mem_save`, split
`item.server`/`item.tool`, a `<server>_<tool>` SQL column, and a double-encoded funnel through
`call_mcp_tool` — share no structure. A normalized intermediate would be a union anyway, and it
would relocate harness knowledge into a shared file, which is exactly what breaks when a fifth
harness lands. Adding a harness = one `ActivitySource` + one detector + one registry line; `domain/`,
`application/`, and `ui/` are untouched. That registry line is the extension test.

### Decision: SSE with snapshot-or-replay resume, not WebSocket

**Choice** `GET /stream` as `text/event-stream`, monotonic `id:` per event, 15 s heartbeat comment.
Launch is `POST /launch`, not a socket frame.

**Alternatives considered** WebSocket; long-polling; client-side file watching.

**Rationale** The stream is strictly server→client, so duplex buys nothing but a dependency and a
hand-rolled reconnect/heartbeat. SSE gives `Last-Event-ID` reconnect for free, which *is* the resume
mechanism. Resume without replaying history:

| Client state | Server response |
|---|---|
| `Last-Event-ID: k`, `k` still in the ring buffer (last 2000) | replay `(k, now]` only |
| `k` evicted from ring, or first connect | one `snapshot` frame (current `OfficeSnapshot` projection, not history) then live |

Backpressure: bounded per-client queue (1000). On pressure, drop oldest **transient** events
(`message`, `tool_start`) and coalesce `stats`/`status` to latest-per-session. Never drop
state-defining events (`session_start`, `session_end`, `parent`, `memory_write`, `launch_*`); if
those would overflow, mark the client desynced and push `snapshot_required`. Client reconnect
backoff 1 s → 30 s with jitter.

### Decision: PixiJS v8 behind a pure-layout boundary

**Choice** PixiJS v8 in `ui/scene/pixi/` only. All layout — desk grid, lane bands, path waypoints,
archive slot assignment — is pure TypeScript in `ui/scene/layout/`.

**Alternatives considered** Hand-rolled Canvas 2D; DOM/SVG.

**Rationale** Sprite batching, ticker, and a WebGL→Canvas fallback are solved; reimplementing them
is spend without return. Keeping layout pure means it is unit-testable without a canvas *and* keeps
the Canvas-2D fallback a real option rather than a claim.

### Decision: read-only SQLite for OpenCode, never `immutable=1`

**Choice** `better-sqlite3` behind the port, opened `{ readonly: true, fileMustExist: true }` plus
`PRAGMA query_only = 1`, `busy_timeout = 0` (we own the backoff).

**Alternatives considered** `immutable=1` (rejected: ignores the live WAL, yields stale/torn
reads); the `opencode serve` SSE `/event` endpoint (rejected: requires a running server we do not
control, and would make the adapter silently absent most of the time); `node:sqlite` (viable,
deferred to slice 3 — the port makes it swappable).

**Rationale** Since OpenCode v1.2 there is no file-based session log, so the prior art's avoidance
of `opencode.db` has no fallback left. A read-only connection cannot checkpoint — that is the safety
property. Hard invariants: never write, never `wal_checkpoint`, never change `journal_mode`, never
delete `-wal`/`-shm`.

### Decision: `child_process` default, PTY behind an out-of-process capability probe

**Choice** Non-interactive `--print`-style launches use `child_process.spawn` with `shell: false`.
PTY is reserved for explicitly interactive sessions and gated by a probe.

**Alternatives considered** PTY always with try/catch (rejected: the documented 2026 macOS arm64
failure is a **native segfault**, which is not catchable in-process and would kill the visualizer);
never offering interactive sessions.

**Rationale** `node-pty` v1.2.0-beta.15 has been beta for 2+ years with active segfault,
spawn-helper permission, and arch-mismatch reports on the exact target platform. Probe design:
resolve the module, then load it **in a short-lived child process** that opens a 1×1 pty running
`/usr/bin/true` and exits; cross-check `process.arch` and the spawn-helper exec bit. A segfault
there is an exit code we read, not a crash we suffer. On `{available:false, reason}` the UI offers a
copyable command line for the user's own terminal — never a silent degrade to a non-TTY run that
would hang on input.

### Decision: animation is a lagging view, ingestion never blocks

**Choice** Events mutate the model immediately; the scene animates behind them and may compress.

**Rationale** A burst of `memory_write` events must not stall the tailer or the SSE fan-out. Per
worker: FIFO carry queue, at most one document held. Beyond `maxQueued` (5), the remainder collapses
into one batch carry with a `×N` badge. Cross-worker concurrency is allowed — the archive has 4
docking slots assigned round-robin, and a fifth worker waits in an adjacent queue line.

## Ingestion Mechanics

### JSONL tailing — Claude Code, Codex, Antigravity

`chokidar` watch → `stat` on `change` → decide from `(size, inode)` against the stored checkpoint:

| Observation | Action |
|---|---|
| `size > checkpoint.size`, same inode | `createReadStream({start: offset})`, split on `\n` |
| `size < checkpoint.size` or inode changed | rotation/truncation: reset `offset = 0`, drop the partial buffer, emit `status(source_reset)`, re-read; de-duplicate by record identity where available |
| `size == checkpoint.size` | no-op |

A trailing fragment without `\n` is **never emitted**: it is held in a `partial` buffer and prefixed
to the next read. Malformed JSON increments a counter and emits `status(parse_error)`; it never
throws (research measured 0 parse errors across 173k Claude lines, so this is purely defensive).

Antigravity follows `transcript.jsonl` **only**. `transcript_full.jsonl` and the
`chunks/transcript*/**` mirrors are ignored as primary sources — following both double-emits. `_full`
is a recovery fallback if a compaction truncation is ever observed; the rotation branch already
handles that case.

### OpenCode SQLite

| Aspect | Decision |
|---|---|
| Cadence | 500 ms default (range 250–2000 ms). Below human animation-latency perception, one indexed query per active session. |
| Query | `SELECT seq, type, data FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq LIMIT 500` via `event_aggregate_seq_idx`; hydrate referenced `part`/`message` rows. `LIMIT 500` is also the natural rate cap. |
| Checkpoint | `max(seq)` per aggregate, committed only **after** the batch is published. |
| `SQLITE_BUSY` / `_SNAPSHOT` / `LOCKED` | Exponential backoff 50→100→200→400→800→1600, cap 2000 ms, full jitter, reset on success. Never an error — a running OpenCode writes constantly, so busy is the normal case. After 30 s continuously busy, emit `status(degraded)` and keep retrying. |
| Startup schema probe | `sqlite_master` + `PRAGMA table_info` for required: `event(aggregate_id, seq, type, data)`, `session(id, parent_id, title, time_created, time_updated)`, `message(id, session_id, data)`, `part(id, message_id, session_id, data)`. Missing required → `disabled(reason:'schema_drift', detail:'event.seq missing')`. Missing **optional** (`agent`, `tokens_*`, `cost`) → `ready` with a degraded-capability flag; labels/stats fall back. |
| `-shm` absent (harness not running, WAL db) | A readonly open can fail `SQLITE_CANTOPEN`. Degrade to `disabled(reason:'wal_shm_unavailable')` and retry on an interval. Do **not** silently fall back to `immutable=1` — that would skip WAL frames and report stale state as live. |

### Session discovery and aging out

| Harness | Discovery |
|---|---|
| Claude Code | glob `~/.claude/projects/*/*.jsonl` plus `*/<sid>/subagents/agent-*.jsonl`; chokidar `add` for new files |
| Codex | glob `~/.codex/sessions/**/rollout-*.jsonl`; watch the current day directory |
| Antigravity | `~/.gemini/antigravity-{cli,ide}/brain/*/.system_generated/logs/transcript.jsonl` |
| OpenCode | `SELECT ... FROM session WHERE time_updated > ?` |

**Bootstrap:** attach only to sessions touched within `activeWindow` (24 h) and start their
checkpoint **at EOF** (`offset = size`, `seq = max(seq)`), not at zero. Replaying 173k Claude lines
and 15.6k OpenCode events on boot would flood the scene. An opt-in `--replay-since` exists for demos
and fixture capture.

**Aging out:** no event for `idleTimeout` (10 min) → `idle` (worker dims, stays on stage); at
`evictTimeout` (60 min) → synthetic `session_end(reason:'timeout')` and the worker leaves. Explicit
terminal signals win when present (OpenCode `time_archived`). Checkpoints for evicted sessions are
retained (LRU, 500 entries) so re-attach resumes instead of replaying.

## Correlation and the Agent Tree

| Harness | Parent edge | Strength | Fallback |
|---|---|---|---|
| Claude Code | `toolUseResult.agentId` in the parent transcript ↔ `agent-<agentId>.jsonl` filename | structured, load-bearing | second independent edge: subagent files live under `<parent-session-id>/subagents/`, so the directory name *is* the parent id |
| OpenCode | `session.parent_id` (36/67 populated, `session_parent_idx`) | first-class column; `session.agent` gives the worker label | none needed |
| Codex | none — only `thread_id`/`turn_id` within one thread | — | flat lane; `turn_id` groups steps inside a lane, it is not a child agent |
| Antigravity | none observed; `SubagentSpec`/`HasSubagents` are compiled-in but never fired in 17 transcripts | — | flat lane, always |

`attributionAgent` is **explicitly demoted to a display hint**. It labels a worker; it never builds
an edge. Label fallback chain: `attributionAgent` → `toolUseResult.description` → `agent-<shortId>`.

**Absent linkage is a flat lane, never a crash.** Every event carries `sessionKey = (harness,
sessionId)`; `AgentTree` is `Map<sessionKey, node>`. A child arriving before its parent goes into a
`pendingChildren` map keyed by claimed parent, resolves on parent arrival, and is **promoted to
root** after `orphanGrace` (5 s). No event is ever dropped. This is a domain invariant with a
dedicated unit test.

## The Office Scene

**Coordinate model:** a fixed logical 1920×1080 floor plan in *scene units*, scaled to the viewport
with letterboxing via one root transform. All layout math runs in scene units, so it is a pure,
deterministic, canvas-free function.

| Landmark | Scene units | Role |
|---|---|---|
| Archive cabinet | `(1720, 540)`, right edge | `memory_write` destination |
| Entrance | `(120, 540)`, left edge | `session_start` / `launch_started` spawn point |
| Desk grid | center, columns × rows | worker home positions |

**Agent → worker:** one `AgentNode` = one worker sprite, identity `sessionKey`. Sprite variant is
`hash(sessionKey)` so a session keeps its avatar across restarts. Harness identity is a badge and
accent color, not a different sprite, so a mixed office stays readable.

| Mode | Layout |
|---|---|
| Single-agent | one centered desk, larger sprite, wider caption strip |
| Multi-agent, flat | one horizontally packed desk row (≤8), overflow scrolls |
| Multi-agent, tree | one **lane** (horizontal band) per root; children indent into the lane as sub-desks with a connector to the parent desk. `laneHeight = floor(1080 / laneCount)`, clamped to a minimum; beyond `maxLanes` (6) the least-recently-active lanes collapse to a summary strip |

**Requirement-6 animation (`memory_write`):** enqueue a `CarryDocument` job → worker walks desk →
archive along a precomputed path (one corridor waypoint so paths do not cut through desks), carrying
a document sprite → the document tweens into the cabinet, the archive counter increments, brief
highlight → worker walks back and returns to `working`/`idle`. Queueing and slot policy per the
lagging-view decision above.

**Captions** are a normalized `{toolLabel, toolDetail}` pair set on `tool_start`, so the renderer
never knows the harness:

| Harness | Caption source |
|---|---|
| Antigravity | de-quoted `args.toolAction` (line 1), de-quoted `args.toolSummary` (line 2) |
| Claude Code | `tool_use.name` + short input digest (`Read: design.md`) |
| Codex | `payload.item.type`; `server`/`tool` for `McpToolCall`, `command` head for `CommandExecution` |
| OpenCode | `part.data.tool` + `state.title` when non-empty |

**Container-presentational:** `containers/OfficeContainer` owns the SSE subscription and the client
projection; `scene/OfficeStage` is presentational and receives an immutable `OfficeViewModel`.
Atomic design maps to `components/`: atoms (badge, caption, counter), molecules (worker, desk,
archive), organisms (lane, floor).

## The Launcher

**Zero-injection, mechanically enforced.** `buildLaunchCommand(spec) → argv[]` is a pure function
built from a per-harness allowlisted template plus user-supplied free arguments. An assertion
rejects `--append-system-prompt`, `--system-prompt`, `--settings`, and `--config` unless the *user*
typed them, and strips our internal env vars while passing `process.env` through otherwise
unchanged. Its unit test asserts byte-identity against the manual command line — that is success
criterion #4.

**Own-process events:** `launch_requested` when the request is accepted (carries a `launchId` we
mint, resolved absolute binary path, argv, cwd); `launch_started` when `spawn` returns a pid with no
immediate `error` (carries pid, `startedAt`); `status(launch_failed, reason)` otherwise. **No harness
log is consulted for any of these.**

### Launch ↔ log correlation

We cannot inject a session id, so we must observe it. A three-signal join:

1. Record `t0 = now()` and the resolved `cwd` **before** spawn.
2. Spawn; record `pid` and `t1`.
3. Open a **claim window** `[t0 − 2s, t1 + 30s]` scoped to `(harness, cwd)`. Every newly discovered
   session is offered to open claims.
4. Per-harness match predicate:

| Harness | Predicate |
|---|---|
| Claude Code | new file under `~/.claude/projects/<slug(cwd)>/` whose first record's `cwd` equals ours and whose `sessionId` is unseen — the slugged directory alone is already a strong filter |
| Codex | new `rollout-*.jsonl` whose `session_meta.payload.git`/cwd matches and whose timestamp falls in the window |
| OpenCode | new `session` row with `directory = cwd` and `time_created` in the window |
| Antigravity | new `brain/<uuid>/` directory created in the window — the transcript carries no cwd, so this relies on time plus "no other `agy` launch in flight" |

5. **Ambiguity policy — never guess.** Exactly one candidate → bind and emit
   `launch_bound(launchId, sessionKey)`. More than one → bind none, emit
   `status(launch_correlation_ambiguous)`; the session still renders, it is simply not attributed.
   Zero before the window closes → `status(launch_correlation_timeout)`.
6. **Serialization guard:** at most one in-flight unclaimed launch per `(harness, cwd)`; a second
   request for the same pair queues until the first binds or times out. This is what makes step 5's
   "exactly one" achievable in practice rather than aspirational.

A failed bind degrades attribution only. It never affects ingestion.

## Interfaces / Contracts

```ts
type EventKind =
  | 'session_start' | 'tool_start' | 'tool_end' | 'message' | 'stats'
  | 'status' | 'parent' | 'session_end'                      // prior art's eight
  | 'memory_write' | 'launch_requested' | 'launch_started';   // ours

interface AgentEventBase {
  id: number;                    // monotonic, server-assigned, SSE `id:`
  kind: EventKind;
  harness: HarnessId;
  sessionKey: string;            // `${harness}:${sessionId}`
  at: number;                    // epoch ms, source-derived when available
  label?: string;                // worker label (session.agent | attributionAgent | fallback)
}
interface MemoryWriteEvent extends AgentEventBase {
  kind: 'memory_write';
  title?: string; topicKey?: string; observationType?: string;
  toolLabel: string; toolDetail?: string;   // scene caption
}
```

## File Changes

| Path | Action | Description |
|---|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.dependency-cruiser.cjs` | Create | Toolchain; defines `npm test` and unblocks `strict_tdd` re-resolution |
| `src/domain/**` | Create | Event model, agent tree, office aggregate — zero deps |
| `src/ports/**` | Create | `ActivitySource`, `SessionLauncher`, `TerminalBackend`, `EventPublisher`, `CheckpointStore`, `Clock` |
| `src/application/**` | Create | Ingestion loop, stream publication, launch use case |
| `src/adapters/driven/{claude-code,codex,antigravity}/**` | Create | JSONL tailer + parser + detector per harness |
| `src/adapters/driven/opencode/**` | Create | Read-only SQLite, schema probe, seq poller, backoff |
| `src/adapters/driven/{launcher,checkpoint}/**` | Create | argv builder + spawn + PTY probe; offset/seq persistence |
| `src/adapters/driving/http/**` | Create | SSE `/stream` with ring + snapshot, `POST /launch` |
| `src/ui/**` | Create | Pixi scene, pure layout, containers, atomic components |
| `test/fixtures/<harness>/**` | Create | Recorded real-log records: true positives and false-positive traps |
| `openspec/config.yaml` | Modify | Set `testing.test_command: "npm test"` once slice 1a lands |

## Testing Strategy

**Runner: Vitest.** Rationale: native TS/ESM without a build step; `vi.useFakeTimers` is required by
the backoff, idle-timeout, and animation-clock tests; snapshot testing fits normalized event output;
browser/jsdom mode covers the container layer. Rejected: `node:test` (weak snapshot/mocking
ergonomics for our fake-timer-heavy suite), Jest (ESM+TS transform overhead for no gain).

**Test command** — this is the artifact that lets a later phase re-resolve `strict_tdd`:
`npm test` → `vitest run`; `npm run test:watch` → `vitest`; `npm run typecheck` → `tsc --noEmit`.

| Layer | What to test | Approach |
|---|---|---|
| Unit | The four `memory_write` detection rules | **Recorded real-log fixtures** per harness — the highest-value tests in the change |
| Unit | Parsers: Antigravity double-decode, Codex record-family discrimination | Table-driven pure functions |
| Unit | Tailer offset math: growth, rotation, truncation, partial trailing line | Temp-dir incremental writes driving the read function directly (no chokidar) |
| Unit | Lane assignment, orphan promotion, archive slot/queue, batch collapse | Pure functions + fake clock |
| Unit | `buildLaunchCommand` byte-identity and injection-flag rejection | Table-driven; success criterion #4 |
| Integration | JSONL adapters end-to-end incl. checkpoint resume | Fixture lines appended to a temp file; assert event sequence and resumed offset |
| Integration | OpenCode probe, seq polling, drift degradation, busy backoff | **Synthetic `opencode.db`** built from the captured DDL. Drift test drops `event.seq` and asserts `disabled(schema_drift)` rather than a throw. Never touches the real db. |
| Integration | SSE reconnect inside and outside the ring; snapshot path | HTTP requests against the real server |
| Contract | Dependency direction | `dependency-cruiser` rule; build fails on violation |

**Mandatory false-positive fixtures** (these catch the real bugs):

| Harness | MUST NOT fire | MUST fire |
|---|---|---|
| Codex | `response_item` / `custom_tool_call` `name:"exec"` whose free text contains the literal `mem_save` | `item.type:"McpToolCall"` + `server:"engram"` + `tool:"mem_save"` |
| Claude Code | `mcp__engram__mem_search`, `mcp__plugin_engram_engram__mem_search` | **both** `mcp__engram__mem_save` and `mcp__plugin_engram_engram__mem_save` |
| OpenCode | `engram_mem_judge`, `engram_mem_save_prompt` | `engram_mem_save` |
| Antigravity | `call_mcp_tool` with `ServerName:"\"codegraph\""`; a naive un-de-quoted equality check must fail the test, proving de-quoting runs | `call_mcp_tool` + de-quoted `ServerName == "engram"` + `ToolName == "mem_save"` |

**Deliberately not automated**

| Excluded | Why | Covered by |
|---|---|---|
| Reads of the real `~/.claude`, `~/.codex`, `~/.local/share/opencode`, `~/.gemini` trees | Machine-specific and mutable; would make the suite non-hermetic | Manual smoke checklist |
| Actually spawning `claude`/`codex`/`opencode`/`agy` | Requires the CLIs, network, and auth | argv/`spawn`-boundary tests with an injected spawn fake + manual acceptance |
| PTY native-binary behavior | The probe exists precisely because this cannot be reliably asserted | The probe itself is tested with a fake child process |
| Pixel-level rendering | Layout math is tested; pixels are reviewed by eye | Manual |

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | **N/A** — the visualizer never classifies or executes any file it reads; every read is parse-only into JSON records | — | — |
| Git repository selection | **N/A** — no VCS automation. `gitBranch` / `session_meta.git` are read as display labels from a transcript, never used to select or act on a repository | — | — |
| Commit state | **N/A** — no commits | — | — |
| Push state | **N/A** — no pushes | — | — |
| PR commands | **N/A** — no PR automation | — | — |
| **Subprocess/shell** *(added — the actual applicable boundary)* | **Applicable** — the launcher spawns harness CLIs | `spawn` with an argv array and `shell: false`, never a shell string; binary resolved to an absolute path via explicit `PATH` lookup and recorded in `launch_requested`; injection-flag denylist; env passthrough minus internal vars; children tracked and `SIGTERM`'d on shutdown | (a) argv byte-identity vs manual command; (b) user-supplied `--append-system-prompt` rejected; (c) an argument containing `; rm -rf /` is passed as one literal argv element, never interpreted; (d) missing binary → `status(launch_failed)`, no throw; (e) shutdown terminates tracked children |
| **Read-only host data** *(added)* | **Applicable** — opening a live harness SQLite with WAL sidecars | `readonly` + `query_only`; never `immutable=1`; never checkpoint; never change `journal_mode`; never delete `-wal`/`-shm`; `SQLITE_BUSY` → backoff | (f) any write statement on the adapter's connection is rejected; (g) `-shm`-absent open degrades to `disabled`, no throw; (h) fixture db mtime, size, and sidecar set are unchanged after a full poll cycle |

Applicable rows carry into `tasks.md` unchanged; their RED tests precede production code.

## Slicing

The proposal's five slices are **confirmed with two revisions**, both argued below.

**Revision 1 — swap slices 4 and 5** (animation before launcher). The animation depends only on
`memory_write`, complete after slice 3, so the dependency graph permits it. Doing it fourth
completes a coherent, shippable, zero-host-risk passive product *before* the first slice that spawns
a process; and it puts the launcher — the only slice that can affect the host at all — last, against
a system that is already fully observable, which is exactly what makes its correlation behavior
debuggable. Trade-off accepted: the launcher's native-dependency risk is discovered late. Mitigated
by running the PTY capability probe as a standalone ~30-line throwaway spike during slice 1.

**Revision 2 — split slice 1**, which is over budget on its own.

**Ordering held for a revised reason:** slice 2 stays second not because "more adapters" but because
it is the **seam-validation slice**. The architectural risk — is `ActivitySource` actually general? —
is the expensive one to discover late, and two cheap JSONL adapters test it directly. OpenCode is
the higher *implementation* risk but shares no code with the tailer, so deferring it costs no rework;
its WAL/`-shm` risk is retired early by a ~40-line throwaway spike in slice 1.

| # | Slice | Content | Est. lines | Risk |
|---|---|---|---|---|
| 1a | Skeleton & contracts | Toolchain, tsconfig, vitest, `domain/events`, `ports/*`, checkpoint store, boundary lint rule, one fake `ActivitySource` proving the seam end-to-end with a stub endpoint, no UI | 300–350 | Low — reviewable as pure contract |
| 1b | First real adapter & scene | JSONL tailer, Claude adapter + detector + fixtures, real SSE server with ring + snapshot, minimal Pixi scene (desks + captions, no animation) | 400–450 | Medium |
| 2 | Codex + Antigravity | Two adapters, two detectors, Antigravity double-decode, fixture suites | 350–400 | Medium |
| 3 | OpenCode SQLite | Driver behind port, schema probe, seq poller, backoff, drift degradation, synthetic-db fixtures | 380–450 | Medium |
| 4 | memory-write animation | Carry state machine, path waypoints, archive slots + queue, batch collapse, caption normalization | 300–350 | Low |
| 5 | Launcher | argv builder + injection guard, spawn adapter, PTY probe + backend port, correlation claim window, `POST /launch` + UI control | 400–480 | Medium-High |

Total ≈ 2100–2500 authored lines (excludes lockfiles and generated assets).

Chain: `1a → 1b → 2 → 3 → 4 → 5`, each PR targeting the previous branch.

```
Decision needed before apply: Yes
Chained PRs recommended: Yes
400-line budget risk: High
```

## Migration / Rollout

No migration. Greenfield, and nothing on the host is mutated: ingestion is read-only, launch is
zero-injection, no harness config, database, or transcript is written. Rollback = stop the process
and delete the source tree. Per-adapter rollback: disable one adapter by config; the other three
continue, since `probe()` already models `disabled` as a first-class state.

## Open Questions

- [ ] Is Antigravity's `transcript.jsonl` genuinely truncated on compaction? Sample size is 1 and
      both files were byte-identical. Defensive path already designed (rotation branch handles it;
      `_full` is recovery-only), so this does not block.
- [ ] `node:sqlite` vs `better-sqlite3` final pick — deferred to slice 3, isolated behind the port.
- [ ] Whether Claude Code appends subagent transcripts atomically. The partial-line buffer covers
      either behavior, so this is informational.
- [ ] Antigravity IDE sessions are read-only by scope decision (launch is `agy`-only); confirm the
      UI badge wording with the user during slice 2.
