# Tasks: Office Agent Visualizer

## Review Budget Policy (maintainer decision, supersedes the forecast below)

**The review budget counts PRODUCTION lines only: 700 per work unit.** Test files
(`*.test.ts`), fixtures under `test/`, and `package-lock.json` are excluded.

Rationale: the first three work units each exceeded a budget that counted tests, while every one
of them stayed well under 500 production lines.

| Work unit | Production | Total excl. lockfile |
|---|---|---|
| PR1 `slice-1a-contracts-toolchain` | 279 | 622 |
| PR2 `slice-1a-ports-spikes` | 497 | 875 |
| PR3 `slice-1b-claude-adapter` | 490 | 1194 |
| PR4 `slice-1b-sse-scene` | 774 | 1720 |

A budget that charges tests rewards writing fewer of them, which is the opposite of what strict TDD
is for in this change: the four `memory_write` detectors are the highest-value tests here, and each
spec scenario mandates its own RED/GREEN pair. In PR3 alone, 490 lines are production and 704 are
tests and fixtures — a healthy ratio, not bloat.

The `gentle-ai sdd-attempt` ledger cannot express "production only", so its `--max-changed-lines`
is set generously and acts as a safety net. The 700-production-line rule is enforced by measuring
each work unit before opening its PR:

```sh
git diff --numstat <base>..<head> -- 'src/**' ':(exclude)src/**/*.test.ts' \
  | awk '{a+=$1; d+=$2} END {print a+d}'
```

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
| 1b | Claude Code adapter + minimal scene | PR3←1a-ii | 400–450 | `npm test -- test/adapters/claude-code test/ui` | Append fixture lines to a temp `.jsonl`, tail via adapter, view scene at the root HTTP route | disable Claude adapter via config; scene falls back to empty state |
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

Slice 1b was split the same way, before implementation started, once Phases 7-8 alone were
estimated near the 400-450 line range for the whole slice (7-10) and the maintainer pre-approved a
1000-line budget for the first slice-1b work unit to absorb strict-TDD test volume (discovery,
tailing, parsing, correlation, and a false-positive-trap-driven detector each need dedicated
RED/GREEN coverage per spec scenario):

- **PR3 (`slice-1b-claude-adapter`, base: `slice-1a-ports-spikes`)** — Phases 7-8: Claude Code
  adapter (discovery, tailing, parsing, parent/child correlation) and its `memory_write` detector
  with sanitized fixtures. 1024 lines excluding `package-lock.json` (`chokidar` added as a
  dependency), of which roughly 600 are tests. No PixiJS, SSE server, or UI code lands here.
- **PR4 (`slice-1b-sse-scene`, base: `slice-1b-claude-adapter`)** — Phases 9-11: the real SSE
  server (ring buffer, snapshot/replay resume, bounded per-client backpressure queue), the
  Office aggregate's structural event projection, pure canvas-free layout math, atomic-design
  components, the PixiJS v8 scene renderer (the only file importing it, enforced by a
  dependency-cruiser rule), the container/presentational split (`OfficeContainer`/`OfficeStage`),
  and slice 1b verification. 774 production lines against the 700-line budget — a 74-line
  (10.6%) overage, smaller than PR3's. This is a single work unit by explicit scope (Phases 9-11
  together complete slice 1b); nothing was compressed or had its tests trimmed to fit the number,
  per the budget rule. Slice 1b is now fully complete across PR3+PR4.
  Manual smoke (task 11.2): discovery + a full tail pass against the real, machine-specific
  `~/.claude/projects/` tree (538 real sessions, 175k+ lines read) left the entire `~/.claude/`
  tree byte-for-byte unchanged (mtime+size snapshot before/after, 4651 files, 0 changed, 0 added).
  One session file exceeded the JS engine's max string length (~536M chars) and could not be read
  in one pass — a read-side limitation only, not a write; it does not affect the no-write proof
  and is out of this work unit's scope to fix (would touch already-completed Phase 7 code).

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

- [x] 4.1 Standalone spike: `node-pty` capability probe running in a **short-lived child process** (1×1 pty, spawns the existing system binary `/usr/bin/true` (read-only) — executed, never written, cross-check `process.arch` + spawn-helper exec bit); exits with `{available:false, reason}` on failure, never crashes the parent — retires launcher risk in slice 1
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

## Slice 1b — PR 3 (base: `slice-1a-ports-spikes`, split into two PRs; see Delivery Revision above) — Claude Code Adapter & Minimal Scene

### Phase 7: Claude Code Adapter — Discovery & Tailing

- [x] 7.1 Create `src/adapters/driven/claude-code/discover.ts` — glob `~/.claude/projects/*/*.jsonl` (read-only host path) plus `*/<sid>/subagents/agent-*.jsonl`; chokidar `add` for new files (Claude Code Session Discovery)
- [x] 7.2 Create `src/adapters/driven/claude-code/tail.ts` — `chokidar` watch → stat-based offset math: growth (read from offset), rotation/truncation (reset, `status(source_reset)`), no-op on equal size, partial trailing-line buffer never emitted
- [x] 7.3 RED+GREEN: temp-dir test — growth, rotation, truncation, partial-line-buffer cases, driving the read function directly (no chokidar)
- [x] 7.4 Create `src/adapters/driven/claude-code/parse.ts` — parse `assistant`/`user`/`system`/`tool_use`/`tool_result` records into `AgentEvent`
- [x] 7.5 Implement parent/child correlation via `toolUseResult.agentId` ↔ `agent-<agentId>.jsonl` filename; second independent edge via `<parent-session-id>/subagents/` directory name
- [x] 7.6 RED+GREEN: subagent correlates to parent via `agentId` alone, independent of `attributionAgent` (Requirement: Claude Code Session Discovery scenarios)
- [x] 7.7 RED+GREEN: missing `attributionAgent` still resolves a deterministic fallback label, correlation unaffected
- [x] 7.8 RED+GREEN: adapter startup performs zero writes under `~/.claude/` (Global No-Write Invariant, Claude Code)

> **Defect found and fixed on this branch (`slice-1b-claude-adapter`, work unit `fix-tail-string-too-long`):** task 11.2's manual smoke test against a real `~/.claude/projects/` tree hit `ERR_STRING_TOO_LONG` in `tail.ts`. Cause: `readFromOffset()` concatenated every stream chunk into one `Buffer` via `Buffer.concat`, and `splitCompleteLines()` then called `buffer.toString('utf8')` on that whole buffer, materializing the entire increment as a single JavaScript string — safe during steady-state tailing (small increments), but the very first read of an existing file starts at `offset = 0`, so the increment is the whole file. Any sufficiently large existing session (one real fixture was 854 MB) broke the adapter at startup. Fixed by reading and decoding the increment in bounded chunks (`createReadStream({ highWaterMark: maxChunkBytes })` + incremental `StringDecoder`, injectable chunk size, default 1 MiB) instead of one whole-buffer read; regression tests added to `tail.test.ts` cover bounded chunk sizes, tiny-chunk/whole-file equivalence, a multi-byte UTF-8 character split across a chunk boundary, and partial-line survival across an internal chunk boundary. Verified against the real 854 MB fixture: old code reproducibly threw `ERR_STRING_TOO_LONG`, fixed code reads it in ~45s with zero writes to the file.

### Phase 8: Claude Code memory_write Detector + Fixtures

- [x] 8.1 Capture and sanitize fixtures from `~/.claude/projects/**/*.jsonl` (read-only) per `research-local-evidence.md` (read-only) Q4/Q5: strip absolute home paths, private project names, unrelated content — commit to `test/fixtures/claude-code/`
- [x] 8.2 Fixture: `tool_use` with `name: "mcp__engram__mem_save"` (true positive)
- [x] 8.3 Fixture: `tool_use` with `name: "mcp__plugin_engram_engram__mem_save"` (true positive)
- [x] 8.4 Fixture: `tool_use` with `name: "mcp__engram__mem_search"` (false-positive trap — MUST NOT fire)
- [x] 8.5 RED: write failing detector tests against all three fixtures above
- [x] 8.6 GREEN: implement `src/adapters/driven/claude-code/memory-write-detector.ts` matching `mcp__*engram*__mem_save`; both fixtures 8.2/8.3 fire, 8.4 does not

### Phase 9: SSE Server

- [x] 9.1 Create `src/adapters/driving/http/stream.ts` — `GET /stream` as `text/event-stream`, monotonic `id:`, 15s heartbeat comment
- [x] 9.2 Implement ring buffer (last 2000 events) + `Last-Event-ID` replay; snapshot frame on evicted/first-connect
- [x] 9.3 Implement bounded per-client queue (1000): drop oldest transient events (`message`, `tool_start`) under pressure, coalesce `stats`/`status`, never drop state-defining events; `snapshot_required` on desync
- [x] 9.4 RED+GREEN: integration test — reconnect inside ring replays only `(k, now]`; reconnect outside ring receives a `snapshot` frame

### Phase 10: Minimal Office Scene

- [x] 10.1 Create `src/ui/scene/layout/` pure TS layout math — 1920×1080 floor plan, desk grid, single-agent centered layout, multi-agent packed row (≤8, overflow scrolls)
- [x] 10.2 RED+GREEN: layout unit tests, canvas-free (Single-Agent Layout, Multi-Agent Layout scenarios)
- [x] 10.3 Create `src/ui/scene/pixi/` (only file importing PixiJS v8) — desks + caption strip, no animation
- [x] 10.4 Create `src/ui/containers/OfficeContainer` (owns SSE subscription + client projection) and `src/ui/scene/OfficeStage` (presentational, receives `OfficeViewModel`)
- [x] 10.5 Create `src/ui/components/atoms|molecules|organisms` per atomic design (badge, caption, worker, desk)
- [x] 10.6 RED+GREEN: worker appears on `session_start`, disappears on `session_end` (Per-Agent Worker Mapping)
- [x] 10.7 RED+GREEN: Claude subagent renders in a visually distinct lane from its parent (Parent/Child Lane Layout, Claude Code only)
- [x] 10.8 RED+GREEN: worker label resolves `attributionAgent` → `toolUseResult.description` → `agent-<shortId>` fallback chain (Worker Label Resolution, Claude Code)

### Phase 11: Slice 1b Verification

- [x] 11.1 Run `npm test` — Claude Code adapter, detector, SSE, scene suites green
- [x] 11.2 Manual smoke: point adapter at a real `~/.claude/projects/` tree (read-only), confirm no file under `~/.claude/` changes (mtime check)

---

## Work Unit: `browser-entrypoint` (approved addition, base: PR4 branch `slice-1b-sse-scene`)

**Not part of the original slicing above.** Slice 1b (Phases 7-11) delivered a complete, tested
engine with no body: 124 passing tests, an injectable `StreamConnection` interface exercised only
with fakes, no real `EventSource`, no HTML entry point, no bundler. This work unit makes it
actually runnable: `npm run dev` starts a server, watches real Claude Code sessions, and serves a
browser page rendering them live over SSE. Approved as an out-of-plan addition; recorded here so
`tasks.md` stays truthful about what shipped and when.

### Phase 28: Real `StreamConnection` — Browser `EventSource`

- [x] 28.1 Create `src/adapters/driving/browser/event-source-stream-connection.ts` — real `StreamConnection`/`StreamConnectionFactory` backed by an injectable `EventSourceLike`/`EventSourceFactory` seam
- [x] 28.2 RED+GREEN: initial connect opens one `EventSource` with no `?lastEventId=`; a bare `message` frame, a named `snapshot` frame, and a named `snapshot_required` frame each project into the correct `StreamMessage`
- [x] 28.3 RED+GREEN: `snapshot_required` forces an immediate reconnect with the tracked id dropped (server responds with a fresh `snapshot`, per `planReplay`'s "no id -> snapshot" rule)
- [x] 28.4 RED+GREEN: reconnect after an error resumes via `?lastEventId=` (a query parameter, since a manually re-created `EventSource` cannot set the `Last-Event-ID` header itself) — `stream.ts`'s `parseLastEventId` extended to accept either the header or the query parameter, header wins if both present
- [x] 28.5 RED+GREEN: exponential backoff 1s -> 2s -> 4s... capped at `maxBackoffMs`, full jitter (injectable `random`); resets to the minimum after a successful `onopen`; `close()` cancels any pending reconnect

### Phase 29: Application Composition Root

- [x] 29.1 Create `src/adapters/driven/claude-code/activity-source.ts` — `ClaudeCodeActivitySource implements ActivitySource`, composing `discover.ts`+`tail.ts`+`parse.ts` behind the one port via `shared/async-queue.ts`; `open()` emits one synthetic `session_start` first (no JSONL record spells that out, and without it a real session would never create a worker in `applyEventToOfficeState`)
- [x] 29.2 RED+GREEN (integration, real temp dir): discover() finds an existing session; open() bootstrap-reads existing content then live-tails newly appended lines; discover+open+close never writes under the harness root
- [x] 29.3 RED+GREEN: fix `ingestAgentActivity` to ingest every discovered session CONCURRENTLY instead of sequentially — a live tail stream never completes on its own, so the original `for await` loop blocked forever on the first session and never `open()`ed a second one
- [x] 29.4 RED+GREEN: fix `FileCheckpointStore` to serialize concurrent `save()` calls (promise-chained queue) — discovered live against the real `~/.claude/projects/` tree (hundreds of concurrent sessions after 29.3) as a torn-write `SyntaxError` crashing the process; without serialization a concurrent save can also silently lose an unrelated session's checkpoint
- [x] 29.5 Create `src/server.ts` — composition root wiring `ClaudeCodeActivitySource` -> `ingestAgentActivity` -> `SseEventHub` -> `createStreamServer`; binds `127.0.0.1` only; `CLAUDE_HOME` env var (default `~/.claude`) overrides the watched root; checkpoint file under this repo's own `.data/`, never under the watched tree

### Phase 30: HTML Entry Point, Bundler, Real PixiJS Renderer

- [x] 30.1 Create `src/ui/scene/pixi/pixi-office-renderer.ts` — `updateStage(stage, viewModel)` (testable core: clears + re-renders the frame, fake `StageLike` in tests) and `PixiOfficeRenderer.mount()` (real `Application`, real canvas — browser-only, not unit-tested)
- [x] 30.2 RED+GREEN: `updateStage` clears the previous frame and adds one desk group per worker, against a fake `StageLike`, using the real (already-tested) `renderOfficeScene`
- [x] 30.3 Create `src/ui/main.ts` — browser composition root: `EventSourceStreamConnection` (real `window.EventSource`) -> `OfficeContainer` -> `OfficeStage` -> `PixiOfficeRenderer` mounted to `#office`. Thin, untested glue — every piece it wires already has its own tests; verified only by loading the page
- [x] 30.4 Create `index.html` + `vite.config.ts` (dev-server proxy of the `/stream` (read-only) HTTP route to the backend port); add `vite` as a direct devDependency (already present transitively via Vitest) and `dev:server`/`dev:client`/`dev`/`build` scripts to `package.json`
- [x] 30.5 Add `"DOM"` to `tsconfig.json`'s `lib` (needed for `EventSource`/`HTMLElement`/`Event` types used by the new browser-facing files)

### Phase 31: Work Unit Verification

- [x] 31.1 Run `npm test` — 148/148 passing (124 baseline + 24 new); `npm run typecheck` — 0 errors; `npm run lint:deps` — 0 violations
- [x] 31.2 End-to-end smoke against a TEMP fixture tree: started the server pointed at a temp dir, appended JSONL lines for a session starting and a tool running, confirmed via `curl -N` that the `/stream` (read-only) HTTP route emitted `session_start` (id 1) -> `tool_start` (id 2) -> `tool_end` (id 3) with monotonic ids
- [x] 31.3 Manual smoke against the real `~/.claude/projects/` tree (read-only): server started cleanly, real sessions appeared in the SSE snapshot, ran ~65s including the tree's largest (854 MB) session; file count and mtime/size snapshot before/after identical (4655/4655) except two files attributable to processes this server does not touch (Claude Code's own `~/.claude/backups/` rotation timer, and this very agent's own live subagent transcript growing as this task was performed)
- [x] 31.4 Write `README.md` at the repo root: what works today, what is explicitly not built yet, the one documented run command, architecture pointer, testing commands

### Phase 32: Viewport Fit (browser verification follow-up)

- [x] 32.1 RED+GREEN: `fitToViewport(w,h)` in `pixi-office-renderer.ts` — contain-fits the fixed
  1920x1080 floor plan into the real viewport (uniform scale, centred letter/pillarboxing, 1:1
  fallback on a degenerate zero-sized container)
- [x] 32.2 Wire it into `PixiOfficeRenderer.mount` — fit once after mount, re-fit on every
  `renderer` resize event. Before this, `resizeTo: container` sized the CANVAS but nothing mapped
  scene units onto it, so the floor was drawn 1:1 in CSS pixels and any window other than exactly
  1920x1080 pushed the desks off-centre and clipped most of the floor
- [x] 32.3 Browser verification (Chrome DevTools, orchestrator — the follow-up Phase 31 left open):
  page loads with no console errors, two fixture sessions render as centred desks, a third `.jsonl`
  appended live appears as a new desk with no reload and the row re-centres
- [x] 32.4 Add README "Verifying the scene renders" section (the renderer's file header already
  pointed at it; it did not exist)

**Review budget**: 612 production lines (`git diff --numstat 7fbfaae..HEAD -- 'src/**' ':(exclude)src/**/*.test.ts'`), within the 700-line work-unit budget.

**What is test-covered vs. manually-verified only**: reconnect/backoff/resume/snapshot projection
(`EventSourceStreamConnection`), the Claude Code `ActivitySource` composition (real temp-dir
integration tests), the ingestion-concurrency fix, the checkpoint-store concurrency fix, and the
PixiJS stage-update logic (`updateStage`) are all unit/integration tested. Mounting a real PixiJS
`Application` to a real `<canvas>` (`PixiOfficeRenderer.mount`) and `src/ui/main.ts`/`src/server.ts`
themselves (thin composition-root glue) are verified only by the manual runs recorded in 31.2/31.3
— this agent has no browser and cannot confirm the page visually renders; that is the orchestrator's
follow-up check.

---

## Slice 2 — PR 3 (base: PR2 branch) — Codex + Antigravity (Seam Validation)

### Phase 12: Codex Adapter + Detector + Fixtures

- [x] 12.1 Create `src/adapters/driven/codex/discover.ts` — glob `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (read-only), watch current day directory
- [x] 12.2 Create `src/adapters/driven/codex/parse.ts` — parse `session_meta`, `event_msg`, `response_item`, `turn_context`, `world_state`, `compacted` record families
- [x] 12.3 RED+GREEN: session file discovered under a date-partitioned tree (Codex Session Discovery scenario)
- [x] 12.4 Capture and sanitize fixtures from `~/.codex/sessions/**/*.jsonl` (read-only) per `research-local-evidence.md` (read-only) Q1 — commit to `test/fixtures/codex/`
- [x] 12.5 Fixture: `event_msg`/`item_completed` with `item.type:"McpToolCall"`, `server:"engram"`, `tool:"mem_save"` (true positive)
- [x] 12.6 Fixture: `response_item`/`custom_tool_call` with `name:"exec"` whose free-text `output` contains the literal string `mem_save` (false-positive trap — MUST NOT fire)
- [x] 12.7 RED: write failing detector tests against both fixtures
- [x] 12.8 GREEN: implement `src/adapters/driven/codex/memory-write-detector.ts`; explicitly excludes `custom_tool_call` family from all detection (memory_write, tool_start/tool_end)
- [x] 12.9 RED+GREEN: adapter startup performs zero writes under `~/.codex/` (Global No-Write Invariant, Codex)

### Phase 13: Antigravity Adapter + Double-Decode Detector + Fixtures

- [x] 13.1 Create `src/adapters/driven/antigravity/discover.ts` — CLI root `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl` (read-only); index `transcript_full.jsonl` as candidate but tail `transcript.jsonl` only; IDE root `~/.gemini/antigravity-ide/brain/<uuid>/...` (read-only) treated as separate, launch-ineligible
- [x] 13.2 RED+GREEN: CLI conversation with both `transcript.jsonl` and `transcript_full.jsonl` records both as candidates, tails only the former
- [x] 13.3 RED+GREEN: IDE session surfaces read-only with no launch affordance (Antigravity IDE Root Separation)
- [x] 13.4 Implement Antigravity config read for `~/.gemini/config/mcp_config.json` (read-only) or workspace `.agents/mcp_config.json` (read-only); explicitly never read the stale `~/.gemini/antigravity-cli/mcp_config.json`
- [x] 13.5 RED+GREEN: adapter never opens the stale config path even when present
- [x] 13.6 Capture and sanitize fixtures from Antigravity CLI/IDE transcripts (read-only) per `research-local-evidence.md` (read-only) Addendum — commit to `test/fixtures/antigravity/`
- [x] 13.7 Fixture: `tool_calls[]` entry `{"name":"call_mcp_tool","args":{"ServerName":"\"engram\"","ToolName":"\"mem_save\"","Arguments":"<json-string>"}}` (true positive)
- [x] 13.8 Fixture: `call_mcp_tool` with `ServerName:"\"codegraph\""` (false-positive trap — MUST NOT fire)
- [x] 13.9 RED: write a test asserting a **naive equality check** (`args.ServerName === "engram"`, no de-quoting) FAILS against fixture 13.7 — proves de-quoting is mandatory
- [x] 13.10 RED: write failing detector tests against fixtures 13.7/13.8 requiring de-quote + second-parse of `Arguments`
- [x] 13.11 GREEN: implement `src/adapters/driven/antigravity/memory-write-detector.ts` — strip one quote layer from `ServerName`/`ToolName` before compare, JSON-parse `Arguments` as a string
- [x] 13.12 RED+GREEN: adapter startup performs zero writes under `~/.gemini/` (Global No-Write Invariant, Antigravity)

### Phase 14: Multi-Agent Scene Updates

- [x] 14.1 RED+GREEN: three unrelated `session_start` events render as three distinct non-overlapping workers (Multi-Agent Layout, cross-harness)
- [x] 14.2 RED+GREEN: Antigravity worker label uses de-quoted `toolAction`/`toolSummary` as caption source (Worker Label Resolution, Antigravity)

### Phase 15: Slice 2 Verification

- [x] 15.1 Run `npm test` — Codex + Antigravity adapter/detector suites green, Claude Code suite unaffected by these changes (Detector Interface Isolation)
- [x] 15.2 Manual smoke: point both adapters at real logs (read-only), confirm no files under `~/.codex/` or `~/.gemini/` change

---

## Slice 3 — PR 4 (base: PR3 branch) — OpenCode Read-Only SQLite Adapter

### Phase 16: OpenCode Adapter — Read-Only Open & Schema Probe

- [x] 16.1 Create `src/adapters/driven/opencode/db.ts` — open `~/.local/share/opencode/opencode.db` (read-only host path) via `better-sqlite3` `{readonly:true, fileMustExist:true}`, `PRAGMA query_only=1`, `busy_timeout=0`; `immutable=1` is explicitly FORBIDDEN — **RESOLVED: implemented with `node:sqlite`'s `DatabaseSync` instead of `better-sqlite3`** (design.md's line-459 open decision; see the resolution note there). `{readOnly: true}` replaces `{readonly:true, fileMustExist:true}` — `DatabaseSync` has no separate `fileMustExist` flag, so a missing/unopenable path is instead reported as `disabled`, never a crash. `query_only=1`/`busy_timeout=0` pragmas applied exactly as specified. `immutable=1` never appears anywhere in this module.
- [x] 16.2 RED+GREEN: any write statement issued on the adapter's connection is rejected (Threat Matrix case f)
- [x] 16.3 Create `src/adapters/driven/opencode/schema-probe.ts` — `sqlite_master` + `PRAGMA table_info` check for required `event(aggregate_id,seq,type,data)`, `session(id,parent_id,title,time_created,time_updated)`, `message(id,session_id,data)`, `part(id,message_id,session_id,data)`; optional `tokens_*`/`cost` missing → degraded-capability flag, not disable — **`session.agent` reclassified from optional to REQUIRED**, see 16.4 and the design.md correction it required.
- [x] 16.4 RED+GREEN: simulated schema drift (drop `session.agent`) degrades to `disabled(reason:'schema_drift', detail:'session.agent missing')`, other three adapters unaffected — using the synthetic-db fixture built from the captured DDL, never the live db. **Deviation from this task's original wording and design.md's schema-probe table**: both originally classified `session.agent` as *optional* (degraded-capability only), which directly contradicts this task's own instruction and the `memory-write-visualization`/`harness-log-ingestion` spec scenario "Missing expected column degrades gracefully" (which explicitly requires dropping `session.agent` to DISABLE the adapter). Implemented per the spec scenario (the acceptance criteria) — `session.agent` is now REQUIRED in `schema-probe.ts`. `detail` reads `session.agent missing`, not the task text's literal (and schema-inconsistent) `event.agent missing` — there is no `event.agent` column in the captured DDL.
- [x] 16.5 RED+GREEN: missing `-shm` sidecar degrades to `disabled(reason:'wal_shm_unavailable')` with retry, never falls back to `immutable=1` (Threat Matrix case g). Implemented as an explicit filesystem precondition check (`-wal` present + `-shm` absent → disabled) rather than relying on `DatabaseSync` to throw: experimentally, a same-process readonly open can still SUCCEED even with `-shm` deleted, so a throw-only strategy would be unreliable. Mutation-tested: removing the precheck makes the RED test fail for the right reason (open silently succeeds instead of disabling).
- [x] 16.6 Do NOT read `storage/` for session data; RED+GREEN: adapter never opens `storage/` for session state (OpenCode Session Access via SQLite Only) — implemented as a structural source-scan test (`zero-write.test.ts`) rather than a runtime fs-mock, since `node:sqlite`'s file access is native and invisible to JS-level mocking; the scan asserts a non-trivial file count first so it cannot pass vacuously.

### Phase 17: OpenCode Seq Polling, Backoff, Drift Degradation

- [x] 17.1 Create `src/adapters/driven/opencode/poll.ts` — `SELECT seq,type,data FROM event WHERE aggregate_id=? AND seq>? ORDER BY seq LIMIT 500` via `event_aggregate_seq_idx`, 500ms default cadence (250–2000ms range); hydrate `part`/`message` rows. **Note**: `event.data`'s exact JSON shape for `message.part.updated.1`/`message.updated.1` events was not directly captured in `research-local-evidence.md` Q3 (only type names and counts were confirmed) — this task's row-level query and checkpointing are fully implemented and tested (17.2-17.6); a generic id-based hydration helper was deliberately NOT added on top of an unconfirmed schema assumption. The `memory_write` detector (18.5) reads `part` rows directly via their own confirmed shape, so it does not depend on event-data hydration.
- [x] 17.2 RED+GREEN: events for one session emitted in ascending `seq` order, none skipped (Per-Session Ordering Guarantee, OpenCode)
- [x] 17.3 Implement `SQLITE_BUSY`/`_SNAPSHOT`/`LOCKED` exponential backoff 50→100→200→400→800→1600ms, cap 2000ms, full jitter, reset on success; after 30s continuous busy emit `status(degraded)`, keep retrying
- [x] 17.4 RED+GREEN: `SQLITE_BUSY` triggers backoff, never surfaces as a failure (OpenCode Read-Only Access Invariants)
- [x] 17.5 Checkpoint `max(seq)` per aggregate, committed only after batch publish
- [x] 17.6 RED+GREEN: fixture db and `-wal` byte-identical, `-shm` never deleted (size/existence preserved) after a full poll cycle (Threat Matrix case h). **Correction found via the 19.2 live smoke test**: an earlier version of this test asserted `-shm` byte-identity too, and passed — but only because its tiny (1-row) fixture never exercised SQLite's WAL-mode shared-memory bookkeeping. Against a larger synthetic fixture (500 rows) AND the real `opencode.db`, `-shm`'s content/mtime legitimately change on a genuinely read-only read (documented SQLite behavior: `-shm` is reader/writer coordination state, not committed data). The test now asserts the invariant design.md actually states — db/`-wal` untouched, `-shm` never deleted/truncated — and was re-verified to fail for the right reason via mutation (appending a byte to `-wal` after the poll cycle).

### Phase 18: OpenCode memory_write Detector + Parent/Child + Fixtures

- [x] 18.1 Capture and sanitize fixtures from a copied `opencode.db` (read-only, scratchpad copy only per research method) per `research-local-evidence.md` (read-only) Q3 — commit synthetic `part`/`event` rows to `test/fixtures/opencode/`. Fixtures are hand-built synthetic JSON matching the confirmed real shape from Q3 (not literal captured rows), per the task's own "synthetic" wording.
- [x] 18.2 Fixture: `part.data->>'$.type'=="tool"`, `part.data->>'$.tool'=="engram_mem_save"` (true positive)
- [x] 18.3 Fixture: `part.data->>'$.tool'=="context7_query-docs"` (false-positive trap — MUST NOT fire)
- [x] 18.4 RED: write failing detector tests against both fixtures
- [x] 18.5 GREEN: implement `src/adapters/driven/opencode/memory-write-detector.ts` matching bare `<server>_<tool>` naming, no `mcp__` prefix. Mutation-verified: removing the tool-name gate makes the false-positive trap fail for the right reason (matching the slice-2 lesson about traps passing incidentally).
- [x] 18.6 Implement `session.parent_id` correlation (first-class column) and `session.agent` as worker label — `src/adapters/driven/opencode/parse.ts`'s `mapOpenCodeSessionToEvents`/`resolveOpenCodeWorkerLabel`.
- [x] 18.7 RED+GREEN: OpenCode child session renders in a lane distinct from its parent, driven by `session.parent_id` (Parent/Child Lane Layout, OpenCode); `session.agent == "observador"` resolves as the worker label (Worker Label Resolution, OpenCode). Verified against the existing generic `domain/office/office.ts` fold (already proven harness-agnostic in phase 10/14) plus a dedicated adapter-level test proving the `parent`-event `correlationId` wiring. Mutation-verified: disabling the `parent_id` branch makes the lane-distinctness test fail for the right reason.

### Phase 19: Slice 3 Verification

- [x] 19.1 Run `npm test` — OpenCode adapter/detector/probe/backoff suites green (253/253 total, run 3x stable)
- [x] 19.2 Manual smoke: point adapter at real `opencode.db` (read-only) while OpenCode is running; confirm no write, checkpoint, or sidecar deletion occurs — see apply-progress for full before/after evidence (db and `-wal` byte-identical; `-shm` size/existence preserved, content legitimately changes per 17.6's correction; write attempt against the real db correctly rejected).

---

## Slice 4 — PR 5 (base: PR4 branch) — memory-write Archive Animation

### Phase 20: Carry State Machine & Archive Slots

- [x] 20.1 Implement `src/domain/office/` carry queue: per-worker FIFO, at most one document held, `maxQueued=5` collapses remainder into one `×N` batch carry
- [x] 20.2 RED+GREEN: fake-clock test — 6 queued `memory_write` events for one worker collapse to 1 held + 1 batch(`×5`)
- [x] 20.3 Implement 4 archive docking slots, round-robin assignment; 5th concurrent worker waits in an adjacent queue line
- [x] 20.4 RED+GREEN: cross-worker concurrency test — 5 simultaneous `memory_write` events, 4 dock immediately, 1 queues

### Phase 21: Path Waypoints, Animation Wiring, Caption Normalization

- [x] 21.1 Implement `src/ui/scene/layout/` path waypoints — desk → one corridor waypoint → archive `(1720,540)`, never cutting through desks
- [ ] 21.2 Wire archive animation: worker walks to archive, document tweens in, counter increments, brief highlight, worker returns to `working`/`idle` — ingestion never blocks (events mutate model immediately, animation lags)
  - [x] Data half: `OfficeViewModel.archiveTrip` (`{path, carryCount}`) is projected from the carry queue and covered by tests
  - [ ] **Render half: NOT built.** Nothing under `src/ui/scene/` or `src/ui/components/` reads `archiveTrip` (verified by grep). No worker walks, no document tweens, no counter, no highlight. The orchestrator confirmed this in Chrome: a real `mcp__engram__mem_save` renders a desk captioned `mcp__engram__mem_save` and nothing else
- [ ] 21.3 RED+GREEN: `memory_write` event for `S1` animates a path to the fixed archive destination (Archive Destination Rendering) — the path is COMPUTED and tested (`archive-path.ts`), but nothing animates it; blocked on 21.2's render half
- [ ] 21.4 RED+GREEN: any harness's `memory_write` (incl. `antigravity`) triggers the same animation path (memory_write Drives Archive Animation Trigger) — path identity across all four harnesses is proven by `archive-trip-cross-harness.test.ts`; the TRIGGER does not exist at runtime, see the blocker below
- [x] 21.5 Implement normalized `{toolLabel, toolDetail}` caption pair on `tool_start`, sourced per-harness (Antigravity de-quoted `toolAction`/`toolSummary`; Claude `tool_use.name` + input digest; Codex `item.type`/`server`/`tool`/command head; OpenCode `part.data.tool`+`state.title`) so the renderer never branches on harness

### BLOCKER discovered during slice 4 verification: `memory_write` is never emitted at runtime

All four `memory-write-detector.ts` files exist, are unit-tested against true-positive and
false-positive fixtures, and are mutation-verified. **None of them is imported by any `parse.ts` or
`activity-source.ts`** (verified by grep across `src/`, excluding tests): the detectors are
orphaned, `createMemoryWriteEvent` is called only from tests, and no `memory_write` event is ever
constructed at runtime.

Consequence: the carry queue, the archive docking slots and the path math are all correct and
tested, but nothing can reach them in a running system. Confirmed end to end — a real
`mcp__engram__mem_save` in a watched session produces only `tool_start` with
`toolLabel: "mcp__engram__mem_save"`; there is no `memory_write` frame on `/stream`.

This is a PLAN gap, not an implementation slip: no phase in this file ever asked for the detectors
to be wired into their adapters' event pipelines. Phases 8, 12, 13 and 18 each say "implement the
detector" and stop. Closing it needs two pieces of work that no current phase covers:

- [ ] B.1 Wire each adapter's detector into its own event pipeline so a matching tool call emits a
  `memory_write` event alongside `tool_start`
- [ ] B.2 Build the render half of 21.2 so `archiveTrip` becomes visible motion

### Phase 22: Slice 4 Verification

- [x] 22.1 Run `npm test` — carry queue, archive slot, waypoint, caption suites green (307/307, independently re-run by the orchestrator) (307/307)
- [ ] 22.2 Replay one `memory_write` fixture per harness (all four) through the SSE stream; visually confirm identical animation path for each — automated path-identity proven by `archive-trip-cross-harness.test.ts`. The VISUAL half is NOT merely pending: it is currently IMPOSSIBLE, because nothing emits `memory_write` at runtime and nothing renders `archiveTrip`. The orchestrator ran the app in Chrome and captured the evidence. Blocked on B.1 and B.2 above

---

## Slice 5 — PR 6 (base: PR5 branch) — Zero-Injection Launcher

### Phase 23: argv Builder & Injection Guard

- [ ] 23.1 Implement `buildLaunchCommand(spec) → argv[]` — per-harness allowlisted template + user-supplied free arguments, pure function
- [ ] 23.2 RED: write failing test asserting argv byte-identity against a manually-typed command line for a plain `claude` launch (Threat Matrix case a / success criterion #4)
- [ ] 23.3 GREEN: implement the allowlisted template to satisfy 23.2
- [ ] 23.4 RED+GREEN: user-supplied `--append-system-prompt`/`--system-prompt`/`--settings`/`--config` rejected unless the user explicitly typed it (Zero-Injection Spawn Invariant, Threat Matrix case b)
- [ ] 23.5 RED+GREEN: an argument containing a destructive shell-metacharacter payload — a `;` command separator followed by `rm -rf` and the filesystem root path, spelled out literally in the test file, never here — is passed as one literal argv element, never shell-interpreted (Threat Matrix case c)
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
