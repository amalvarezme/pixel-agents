# Tasks: Office Agent Visualizer

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2100–2500 total, 300–480 per slice |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 (1a-i) → PR2 (1a-ii) → PR3 (1b) → PR4 (2) → PR5 (3) → PR6 (4) → PR7 (5) |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High
```

Six slices, each PR targets the previous slice's branch (PR1 targets `main`). Animation (slice 4)
intentionally lands before the launcher (slice 5): a shippable, zero-host-risk passive product
completes first; the only host-affecting slice lands last against a fully observable system.

### Suggested Work Units

| Unit | Goal | PR | Est. lines | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|---|
| 1a-i | Toolchain + domain contracts | PR1←main | 578 actual | `npm test` | N/A — pure domain, no I/O yet | delete `src/domain`, `package.json` |
| 1a-ii | Ports, checkpoint store, risk spikes, seam validation | PR2←1a-i | 400–600 | `npm test -- src/ports test/spikes` | Spike probes only, both out-of-process | delete `src/ports`, `src/adapters/driven/checkpoint`, spikes |
| 1b | Claude Code adapter + minimal scene | PR3←1a-ii | 400–450 | `npm test -- test/adapters/claude-code test/ui` | Append fixture lines to a temp `.jsonl`, tail via adapter, view scene at `/` | disable Claude adapter via config; scene falls back to empty state |
| 2 | Codex + Antigravity adapters | PR4←1b | 350–400 | `npm test -- test/adapters/codex test/adapters/antigravity` | Fixture playback for both harnesses | disable each adapter independently via config |
| 3 | OpenCode read-only SQLite adapter | PR5←2 | 380–450 | `npm test -- test/adapters/opencode` | Query synthetic `opencode.db` copy; never touch live db | disable OpenCode adapter via config |
| 4 | memory-write archive animation | PR6←3 | 300–350 | `npm test -- test/ui/scene` | Replay recorded `memory_write` fixtures through SSE, watch scene | revert `ui/scene` animation files; desks/captions still render |
| 5 | Zero-injection launcher | PR7←4 | 400–480 | `npm test -- test/launcher` | Launch `claude --help`-equivalent via spawn fake, then one manual real launch | remove `POST /launch` route + launcher UI control |

---

## Delivery Revision (maintainer decision)

Slice 1a was split into two PRs after Phases 1-2 alone produced 578 reviewable lines against a
300-350 estimate. The estimate was wrong; the work was not reduced, and nothing was compressed to
fit a number.

- **PR1 (`slice-1a-contracts-toolchain`)** — Phases 1-2: toolchain and domain contracts. 578 lines
  excluding `package-lock.json`, of which roughly 250 are tests and 52 are SDD artifact churn.
- **PR2 (`slice-1a-ports-spikes`)** — Phases 3-6: ports, checkpoint store, both risk-retirement
  spikes, seam validation, and slice verification.

The runtime attempt ledger recorded 2698 changed lines for the first attempt because it counts
`package-lock.json` (~2120 lines), which carries no review surface. The objective was reset by the
maintainer with a 3000-line budget for this first unit to absorb the one-time lockfile, and 800 for
every unit after it.

## Slice 1a — PR 1 (base: `main`) — Contracts & Toolchain (Phases 1-2)

### Phase 1: Toolchain Setup

- [x] 1.1 Create `package.json`, `tsconfig.json`, `vitest.config.ts` with Node/TS + Vitest (satisfies design's Runner decision)
- [x] 1.2 Create `.dependency-cruiser.cjs` rule forbidding `domain/` from importing `adapters/`, `ui/`, or third-party runtime packages
- [x] 1.3 Set `testing.test_command: "npm test"` in `openspec/config.yaml`; add `npm run test:watch` and `npm run typecheck` scripts to `package.json` — this unblocks re-resolving `strict_tdd`
- [x] 1.4 RED: add a `dependency-cruiser` test asserting a deliberate `domain → adapters` import fails the build
- [x] 1.5 GREEN: run `npx dependency-cruiser` in CI script; confirm the rule is enforced (Contract: Dependency direction)

### Phase 2: Domain — Events, Agents, Office

- [x] 2.1 Create `src/domain/events/` — `AgentEvent` union (11 canonical types: 8 prior-art + `memory_write`, `launch_requested`, `launch_started`), factories, envelope fields (harness, sessionKey, id, at, label)
- [x] 2.2 RED: test asserting no 12th event type can be constructed (Canonical Event Type Set)
- [x] 2.3 RED: test asserting `launch_requested`/`launch_started` are excluded from any log-parse factory (Event Origination Provenance)
- [x] 2.4 Create `src/domain/agents/` — `AgentId`, `AgentNode`, `AgentTree` (`Map<sessionKey, node>`), `pendingChildren` map, `orphanGrace` promotion
- [x] 2.5 RED+GREEN: unit test — child arriving before parent resolves on parent arrival; promotes to root after `orphanGrace` (5s, fake clock); no event ever dropped
- [x] 2.6 Create `src/domain/sessions/` — `SessionKey`, lifecycle (`active|idle|ended`), `idleTimeout` (10m) / `evictTimeout` (60m) transitions
- [x] 2.7 RED+GREEN: fake-clock test for idle-then-evict transition emitting synthetic `session_end(reason:'timeout')`
- [x] 2.8 Create `src/domain/office/` — `Office` aggregate skeleton (workers, lanes, archive, carry queue types only; behavior lands in slice 4)

### Phase 3: Ports & Checkpoint Store

- [x] 3.1 Create `src/ports/activity-source.port.ts` — `ActivitySource`, `ActivityStream`, `SourceHealth`, `MemoryWriteDetector<TRecord>` interfaces
- [x] 3.2 Create `src/ports/checkpoint-store.port.ts`, `event-publisher.port.ts`, `session-launcher.port.ts`, `terminal-backend.port.ts`, `clock.port.ts`
- [x] 3.3 Create `src/adapters/driven/checkpoint/` — in-memory + file-backed `CheckpointStore` (opaque `{kind:'byte-offset'...}` / `{kind:'seq'...}` blobs)
- [x] 3.4 RED+GREEN: checkpoint round-trips byte-for-byte through save/load

### Phase 4: Risk-Retirement Spikes

- [x] 4.1 Standalone spike: `node-pty` capability probe running in a **short-lived child process** (1×1 pty, `/usr/bin/true`, cross-check `process.arch` + spawn-helper exec bit); exits with `{available:false, reason}` on failure, never crashes the parent — retires launcher risk in slice 1
- [x] 4.2 RED+GREEN: probe test using a fake child process that simulates a non-zero/segfault exit code; parent process asserted alive
- [x] 4.3 Standalone ~40-line spike: open a copied `opencode.db` read-only, run one `PRAGMA table_info` + one `event` query against the real schema — retires OpenCode implementation risk early; discard after slice 3 lands

### Phase 5: Seam Validation — Fake Adapter + SSE Stub

- [x] 5.1 Implement one fake `ActivitySource` (in-memory, no I/O) proving `discover()`/`open()`/`close()` end-to-end
- [x] 5.2 Create `src/application/ingest-agent-activity/` use case wiring the fake source to the event bus
- [x] 5.3 Create a stub HTTP endpoint (no real SSE yet) proving the port → application → bus seam compiles and runs

### Phase 6: Slice 1a Verification

- [x] 6.1 Run `npm test` — all domain/port/checkpoint tests green
- [x] 6.2 Run `npm run typecheck` — zero errors
- [x] 6.3 Confirm `openspec/config.yaml` `testing.test_command` is `"npm test"` (unblocks strict TDD re-resolution for slice 1b+)

---

## Slice 1b — PR 2 (base: PR1 branch) — Claude Code Adapter & Minimal Scene

### Phase 7: Claude Code Adapter — Discovery & Tailing

- [ ] 7.1 Create `src/adapters/driven/claude-code/discover.ts` — glob `~/.claude/projects/*/*.jsonl` (read-only host path) plus `*/<sid>/subagents/agent-*.jsonl`; chokidar `add` for new files (Claude Code Session Discovery)
- [ ] 7.2 Create `src/adapters/driven/claude-code/tail.ts` — `chokidar` watch → stat-based offset math: growth (read from offset), rotation/truncation (reset, `status(source_reset)`), no-op on equal size, partial trailing-line buffer never emitted
- [ ] 7.3 RED+GREEN: temp-dir test — growth, rotation, truncation, partial-line-buffer cases, driving the read function directly (no chokidar)
- [ ] 7.4 Create `src/adapters/driven/claude-code/parse.ts` — parse `assistant`/`user`/`system`/`tool_use`/`tool_result` records into `AgentEvent`
- [ ] 7.5 Implement parent/child correlation via `toolUseResult.agentId` ↔ `agent-<agentId>.jsonl` filename; second independent edge via `<parent-session-id>/subagents/` directory name
- [ ] 7.6 RED+GREEN: subagent correlates to parent via `agentId` alone, independent of `attributionAgent` (Requirement: Claude Code Session Discovery scenarios)
- [ ] 7.7 RED+GREEN: missing `attributionAgent` still resolves a deterministic fallback label, correlation unaffected
- [ ] 7.8 RED+GREEN: adapter startup performs zero writes under `~/.claude/` (Global No-Write Invariant, Claude Code)

### Phase 8: Claude Code memory_write Detector + Fixtures

- [ ] 8.1 Capture and sanitize fixtures from `~/.claude/projects/**/*.jsonl` (read-only) per `research-local-evidence.md` (read-only) Q4/Q5: strip absolute home paths, private project names, unrelated content — commit to `test/fixtures/claude-code/`
- [ ] 8.2 Fixture: `tool_use` with `name: "mcp__engram__mem_save"` (true positive)
- [ ] 8.3 Fixture: `tool_use` with `name: "mcp__plugin_engram_engram__mem_save"` (true positive)
- [ ] 8.4 Fixture: `tool_use` with `name: "mcp__engram__mem_search"` (false-positive trap — MUST NOT fire)
- [ ] 8.5 RED: write failing detector tests against all three fixtures above
- [ ] 8.6 GREEN: implement `src/adapters/driven/claude-code/memory-write-detector.ts` matching `mcp__*engram*__mem_save`; both fixtures 8.2/8.3 fire, 8.4 does not

### Phase 9: SSE Server

- [ ] 9.1 Create `src/adapters/driving/http/stream.ts` — `GET /stream` as `text/event-stream`, monotonic `id:`, 15s heartbeat comment
- [ ] 9.2 Implement ring buffer (last 2000 events) + `Last-Event-ID` replay; snapshot frame on evicted/first-connect
- [ ] 9.3 Implement bounded per-client queue (1000): drop oldest transient events (`message`, `tool_start`) under pressure, coalesce `stats`/`status`, never drop state-defining events; `snapshot_required` on desync
- [ ] 9.4 RED+GREEN: integration test — reconnect inside ring replays only `(k, now]`; reconnect outside ring receives a `snapshot` frame

### Phase 10: Minimal Office Scene

- [ ] 10.1 Create `src/ui/scene/layout/` pure TS layout math — 1920×1080 floor plan, desk grid, single-agent centered layout, multi-agent packed row (≤8, overflow scrolls)
- [ ] 10.2 RED+GREEN: layout unit tests, canvas-free (Single-Agent Layout, Multi-Agent Layout scenarios)
- [ ] 10.3 Create `src/ui/scene/pixi/` (only file importing PixiJS v8) — desks + caption strip, no animation
- [ ] 10.4 Create `src/ui/containers/OfficeContainer` (owns SSE subscription + client projection) and `src/ui/scene/OfficeStage` (presentational, receives `OfficeViewModel`)
- [ ] 10.5 Create `src/ui/components/atoms|molecules|organisms` per atomic design (badge, caption, worker, desk)
- [ ] 10.6 RED+GREEN: worker appears on `session_start`, disappears on `session_end` (Per-Agent Worker Mapping)
- [ ] 10.7 RED+GREEN: Claude subagent renders in a visually distinct lane from its parent (Parent/Child Lane Layout, Claude Code only)
- [ ] 10.8 RED+GREEN: worker label resolves `attributionAgent` → `toolUseResult.description` → `agent-<shortId>` fallback chain (Worker Label Resolution, Claude Code)

### Phase 11: Slice 1b Verification

- [ ] 11.1 Run `npm test` — Claude Code adapter, detector, SSE, scene suites green
- [ ] 11.2 Manual smoke: point adapter at a real `~/.claude/projects/` tree (read-only), confirm no file under `~/.claude/` changes (mtime check)

---

## Slice 2 — PR 3 (base: PR2 branch) — Codex + Antigravity (Seam Validation)

### Phase 12: Codex Adapter + Detector + Fixtures

- [ ] 12.1 Create `src/adapters/driven/codex/discover.ts` — glob `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (read-only), watch current day directory
- [ ] 12.2 Create `src/adapters/driven/codex/parse.ts` — parse `session_meta`, `event_msg`, `response_item`, `turn_context`, `world_state`, `compacted` record families
- [ ] 12.3 RED+GREEN: session file discovered under a date-partitioned tree (Codex Session Discovery scenario)
- [ ] 12.4 Capture and sanitize fixtures from `~/.codex/sessions/**/*.jsonl` (read-only) per `research-local-evidence.md` (read-only) Q1 — commit to `test/fixtures/codex/`
- [ ] 12.5 Fixture: `event_msg`/`item_completed` with `item.type:"McpToolCall"`, `server:"engram"`, `tool:"mem_save"` (true positive)
- [ ] 12.6 Fixture: `response_item`/`custom_tool_call` with `name:"exec"` whose free-text `output` contains the literal string `mem_save` (false-positive trap — MUST NOT fire)
- [ ] 12.7 RED: write failing detector tests against both fixtures
- [ ] 12.8 GREEN: implement `src/adapters/driven/codex/memory-write-detector.ts`; explicitly excludes `custom_tool_call` family from all detection (memory_write, tool_start/tool_end)
- [ ] 12.9 RED+GREEN: adapter startup performs zero writes under `~/.codex/` (Global No-Write Invariant, Codex)

### Phase 13: Antigravity Adapter + Double-Decode Detector + Fixtures

- [ ] 13.1 Create `src/adapters/driven/antigravity/discover.ts` — CLI root `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl` (read-only); index `transcript_full.jsonl` as candidate but tail `transcript.jsonl` only; IDE root `~/.gemini/antigravity-ide/brain/<uuid>/...` (read-only) treated as separate, launch-ineligible
- [ ] 13.2 RED+GREEN: CLI conversation with both `transcript.jsonl` and `transcript_full.jsonl` records both as candidates, tails only the former
- [ ] 13.3 RED+GREEN: IDE session surfaces read-only with no launch affordance (Antigravity IDE Root Separation)
- [ ] 13.4 Implement Antigravity config read for `~/.gemini/config/mcp_config.json` (read-only) or workspace `.agents/mcp_config.json` (read-only); explicitly never read the stale `~/.gemini/antigravity-cli/mcp_config.json`
- [ ] 13.5 RED+GREEN: adapter never opens the stale config path even when present
- [ ] 13.6 Capture and sanitize fixtures from Antigravity CLI/IDE transcripts (read-only) per `research-local-evidence.md` (read-only) Addendum — commit to `test/fixtures/antigravity/`
- [ ] 13.7 Fixture: `tool_calls[]` entry `{"name":"call_mcp_tool","args":{"ServerName":"\"engram\"","ToolName":"\"mem_save\"","Arguments":"<json-string>"}}` (true positive)
- [ ] 13.8 Fixture: `call_mcp_tool` with `ServerName:"\"codegraph\""` (false-positive trap — MUST NOT fire)
- [ ] 13.9 RED: write a test asserting a **naive equality check** (`args.ServerName === "engram"`, no de-quoting) FAILS against fixture 13.7 — proves de-quoting is mandatory
- [ ] 13.10 RED: write failing detector tests against fixtures 13.7/13.8 requiring de-quote + second-parse of `Arguments`
- [ ] 13.11 GREEN: implement `src/adapters/driven/antigravity/memory-write-detector.ts` — strip one quote layer from `ServerName`/`ToolName` before compare, JSON-parse `Arguments` as a string
- [ ] 13.12 RED+GREEN: adapter startup performs zero writes under `~/.gemini/` (Global No-Write Invariant, Antigravity)

### Phase 14: Multi-Agent Scene Updates

- [ ] 14.1 RED+GREEN: three unrelated `session_start` events render as three distinct non-overlapping workers (Multi-Agent Layout, cross-harness)
- [ ] 14.2 RED+GREEN: Antigravity worker label uses de-quoted `toolAction`/`toolSummary` as caption source (Worker Label Resolution, Antigravity)

### Phase 15: Slice 2 Verification

- [ ] 15.1 Run `npm test` — Codex + Antigravity adapter/detector suites green, Claude Code suite unaffected by these changes (Detector Interface Isolation)
- [ ] 15.2 Manual smoke: point both adapters at real logs (read-only), confirm no files under `~/.codex/` or `~/.gemini/` change

---

## Slice 3 — PR 4 (base: PR3 branch) — OpenCode Read-Only SQLite Adapter

### Phase 16: OpenCode Adapter — Read-Only Open & Schema Probe

- [ ] 16.1 Create `src/adapters/driven/opencode/db.ts` — open `~/.local/share/opencode/opencode.db` (read-only host path) via `better-sqlite3` `{readonly:true, fileMustExist:true}`, `PRAGMA query_only=1`, `busy_timeout=0`; `immutable=1` is explicitly FORBIDDEN
- [ ] 16.2 RED+GREEN: any write statement issued on the adapter's connection is rejected (Threat Matrix case f)
- [ ] 16.3 Create `src/adapters/driven/opencode/schema-probe.ts` — `sqlite_master` + `PRAGMA table_info` check for required `event(aggregate_id,seq,type,data)`, `session(id,parent_id,title,time_created,time_updated)`, `message(id,session_id,data)`, `part(id,message_id,session_id,data)`; optional `agent`/`tokens_*`/`cost` missing → degraded-capability flag, not disable
- [ ] 16.4 RED+GREEN: simulated schema drift (drop `session.agent`) degrades to `disabled(reason:'schema_drift', detail:'event.agent missing')`, other three adapters unaffected — using the synthetic-db fixture built from the captured DDL, never the live db
- [ ] 16.5 RED+GREEN: missing `-shm` sidecar degrades to `disabled(reason:'wal_shm_unavailable')` with retry, never falls back to `immutable=1` (Threat Matrix case g)
- [ ] 16.6 Do NOT read `storage/` for session data; RED+GREEN: adapter never opens `storage/` for session state (OpenCode Session Access via SQLite Only)

### Phase 17: OpenCode Seq Polling, Backoff, Drift Degradation

- [ ] 17.1 Create `src/adapters/driven/opencode/poll.ts` — `SELECT seq,type,data FROM event WHERE aggregate_id=? AND seq>? ORDER BY seq LIMIT 500` via `event_aggregate_seq_idx`, 500ms default cadence (250–2000ms range); hydrate `part`/`message` rows
- [ ] 17.2 RED+GREEN: events for one session emitted in ascending `seq` order, none skipped (Per-Session Ordering Guarantee, OpenCode)
- [ ] 17.3 Implement `SQLITE_BUSY`/`_SNAPSHOT`/`LOCKED` exponential backoff 50→100→200→400→800→1600ms, cap 2000ms, full jitter, reset on success; after 30s continuous busy emit `status(degraded)`, keep retrying
- [ ] 17.4 RED+GREEN: `SQLITE_BUSY` triggers backoff, never surfaces as a failure (OpenCode Read-Only Access Invariants)
- [ ] 17.5 Checkpoint `max(seq)` per aggregate, committed only after batch publish
- [ ] 17.6 RED+GREEN: fixture db mtime, size, and sidecar (`-wal`/`-shm`) set unchanged after a full poll cycle (Threat Matrix case h)

### Phase 18: OpenCode memory_write Detector + Parent/Child + Fixtures

- [ ] 18.1 Capture and sanitize fixtures from a copied `opencode.db` (read-only, scratchpad copy only per research method) per `research-local-evidence.md` (read-only) Q3 — commit synthetic `part`/`event` rows to `test/fixtures/opencode/`
- [ ] 18.2 Fixture: `part.data->>'$.type'=="tool"`, `part.data->>'$.tool'=="engram_mem_save"` (true positive)
- [ ] 18.3 Fixture: `part.data->>'$.tool'=="context7_query-docs"` (false-positive trap — MUST NOT fire)
- [ ] 18.4 RED: write failing detector tests against both fixtures
- [ ] 18.5 GREEN: implement `src/adapters/driven/opencode/memory-write-detector.ts` matching bare `<server>_<tool>` naming, no `mcp__` prefix
- [ ] 18.6 Implement `session.parent_id` correlation (first-class column) and `session.agent` as worker label
- [ ] 18.7 RED+GREEN: OpenCode child session renders in a lane distinct from its parent, driven by `session.parent_id` (Parent/Child Lane Layout, OpenCode); `session.agent == "observador"` resolves as the worker label (Worker Label Resolution, OpenCode)

### Phase 19: Slice 3 Verification

- [ ] 19.1 Run `npm test` — OpenCode adapter/detector/probe/backoff suites green
- [ ] 19.2 Manual smoke: point adapter at real `opencode.db` (read-only) while OpenCode is running; confirm no write, checkpoint, or sidecar deletion occurs

---

## Slice 4 — PR 5 (base: PR4 branch) — memory-write Archive Animation

### Phase 20: Carry State Machine & Archive Slots

- [ ] 20.1 Implement `src/domain/office/` carry queue: per-worker FIFO, at most one document held, `maxQueued=5` collapses remainder into one `×N` batch carry
- [ ] 20.2 RED+GREEN: fake-clock test — 6 queued `memory_write` events for one worker collapse to 1 held + 1 batch(`×5`)
- [ ] 20.3 Implement 4 archive docking slots, round-robin assignment; 5th concurrent worker waits in an adjacent queue line
- [ ] 20.4 RED+GREEN: cross-worker concurrency test — 5 simultaneous `memory_write` events, 4 dock immediately, 1 queues

### Phase 21: Path Waypoints, Animation Wiring, Caption Normalization

- [ ] 21.1 Implement `src/ui/scene/layout/` path waypoints — desk → one corridor waypoint → archive `(1720,540)`, never cutting through desks
- [ ] 21.2 Wire archive animation: worker walks to archive, document tweens in, counter increments, brief highlight, worker returns to `working`/`idle` — ingestion never blocks (events mutate model immediately, animation lags)
- [ ] 21.3 RED+GREEN: `memory_write` event for `S1` animates a path to the fixed archive destination (Archive Destination Rendering)
- [ ] 21.4 RED+GREEN: any harness's `memory_write` (incl. `antigravity`) triggers the same animation path (memory_write Drives Archive Animation Trigger)
- [ ] 21.5 Implement normalized `{toolLabel, toolDetail}` caption pair on `tool_start`, sourced per-harness (Antigravity de-quoted `toolAction`/`toolSummary`; Claude `tool_use.name` + input digest; Codex `item.type`/`server`/`tool`/command head; OpenCode `part.data.tool`+`state.title`) so the renderer never branches on harness

### Phase 22: Slice 4 Verification

- [ ] 22.1 Run `npm test` — carry queue, archive slot, waypoint, caption suites green
- [ ] 22.2 Replay one `memory_write` fixture per harness (all four) through the SSE stream; visually confirm identical animation path for each

---

## Slice 5 — PR 6 (base: PR5 branch) — Zero-Injection Launcher

### Phase 23: argv Builder & Injection Guard

- [ ] 23.1 Implement `buildLaunchCommand(spec) → argv[]` — per-harness allowlisted template + user-supplied free arguments, pure function
- [ ] 23.2 RED: write failing test asserting argv byte-identity against a manually-typed command line for a plain `claude` launch (Threat Matrix case a / success criterion #4)
- [ ] 23.3 GREEN: implement the allowlisted template to satisfy 23.2
- [ ] 23.4 RED+GREEN: user-supplied `--append-system-prompt`/`--system-prompt`/`--settings`/`--config` rejected unless the user explicitly typed it (Zero-Injection Spawn Invariant, Threat Matrix case b)
- [ ] 23.5 RED+GREEN: an argument containing `; rm -rf /` is passed as one literal argv element, never shell-interpreted (Threat Matrix case c)
- [ ] 23.6 RED+GREEN: internal env vars stripped, `process.env` otherwise passed through unchanged

### Phase 24: Spawn Adapter & PTY Backend

- [ ] 24.1 Implement `child_process.spawn` default path (`shell:false`, absolute-path binary resolution via explicit `PATH` lookup)
- [ ] 24.2 RED+GREEN: missing binary → `status(launch_failed)`, never a throw (Threat Matrix case d / Unavailable Harness CLI Handling)
- [ ] 24.3 Wire the slice-1a PTY probe (Phase 4.1) as the gate for interactive-session PTY backend selection; `{available:false}` surfaces a copyable command line, never a silent non-TTY degrade
- [ ] 24.4 Implement tracked-child registry + `SIGTERM` on shutdown
- [ ] 24.5 RED+GREEN: shutdown terminates all tracked children (Threat Matrix case e)
- [ ] 24.6 RED+GREEN: `launch_requested` (accepted, carries `launchId`/binary path/argv/cwd) then `launch_started` (pid, `startedAt`) emitted only from launcher process state, never from a log parse (Self-Originated Launch Events Only)
- [ ] 24.7 RED+GREEN: `agy` missing from `PATH` — `launch_requested` emitted, then a failure signal, `launch_started` never emitted (Unavailable Harness CLI Handling)
- [ ] 24.8 RED+GREEN: Antigravity IDE session has no launch control presented (Supported Launch Targets)

### Phase 25: Launch↔Log Correlation

- [ ] 25.1 Implement claim window `[t0−2s, t1+30s]` scoped to `(harness, cwd)`, recorded before/at spawn
- [ ] 25.2 Implement per-harness match predicates (Claude Code slug-dir + cwd + unseen sessionId; Codex rollout cwd+timestamp; OpenCode `session.directory`+`time_created`; Antigravity new `brain/<uuid>/` + no other in-flight `agy` launch)
- [ ] 25.3 RED+GREEN: exactly one candidate binds and emits `launch_bound`; zero/ambiguous candidates bind nothing and emit `status(launch_correlation_timeout|ambiguous)` — a failed bind degrades attribution only, ingestion unaffected
- [ ] 25.4 Implement per-`(harness,cwd)` serialization guard — a second request for the same pair queues until the first binds or times out
- [ ] 25.5 RED+GREEN: two concurrent launch requests for the same `(harness,cwd)` never produce two open unclaimed claims simultaneously

### Phase 26: `POST /launch` + UI Control + Subsystem Separation

- [ ] 26.1 Create `src/adapters/driving/http/launch.ts` — `POST /launch` route wiring the launcher use case
- [ ] 26.2 Add launcher UI control to `ui/components/` (organism) wired through `OfficeContainer`
- [ ] 26.3 RED+GREEN (dependency-cruiser rule extension): launcher module has no import edge to any `adapters/driven/{claude-code,codex,opencode,antigravity}` tailer/parser file (Subsystem Separation from Ingestion)
- [ ] 26.4 RED+GREEN: modifying the launcher's spawn mechanism leaves all four adapters' existing fixture suites unaffected

### Phase 27: Slice 5 Verification (full-system)

- [ ] 27.1 Run `npm test` — launcher, correlation, and full regression suite (all prior slices) green
- [ ] 27.2 Manual smoke: launch one real harness CLI from the scene; diff the resulting argv against a manual invocation (byte-identical)
- [ ] 27.3 Manual smoke: confirm zero writes to any of `~/.claude/`, `~/.codex/`, `~/.local/share/opencode/`, `~/.gemini/` config/hook/db/transcript paths across a full launch + ingest + animate cycle

## Key Learnings

1. `memory_write` detection is per-adapter and typed on that adapter's own record shape; no shared pattern match exists across the four harnesses.
2. The `node-pty` capability probe must run in a short-lived child process because a native segfault cannot be caught in-process.
3. `immutable=1` is forbidden for the OpenCode SQLite adapter because it skips uncommitted WAL frames and reports stale state as live.
4. Antigravity's `ServerName`/`ToolName` values are double-encoded JSON strings; a naive equality check against the raw value always fails, which is itself the proof the de-quoting step is mandatory.
5. Animation (slice 4) depends only on `memory_write`, complete after slice 3, so it can ship as a passive product before the launcher — the only host-affecting slice — lands last.
