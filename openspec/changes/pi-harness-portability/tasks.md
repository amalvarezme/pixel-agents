# Tasks: Pi Harness Portability

## Review Budget Policy

Inherited from the archived `office-agent-visualizer` change and unchanged here: **the review budget
counts PRODUCTION lines only, 700 per work unit.** `*.test.ts`, fixtures under `test/`, and
`package-lock.json` are excluded.

Measured before opening each PR:

```sh
git diff --numstat <base>..<head> -- 'src/**' ':(exclude)src/**/*.test.ts' \
  | awk '{a+=$1; d+=$2} END {print a+d}'
```

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated production lines | ~1000–1200 total |
| MEASURED production lines | ~1580 total |
| Per work unit (measured) | WU1 ~660, WU2 ~860, WU3 ~160 (+ ~60 threading) |
| 700-line budget risk | **WU2 exceeds the 700-line budget as planned** — see below |
| Chained PRs recommended | Yes — four, stacked to `main` |
| Delivery strategy | ask-on-risk |

**WU2 overran its budget and must be split before review.** The measured split is clean, because
the two halves have no shared mutable state and each is independently green:

- **WU2a** `pi-presence-reader` — `presence-read.ts` (~356) + `correlate.ts` (~51) = ~407 lines,
  18 + 7 tests. Pure reading and hashing; publishes nothing.
- **WU2b** `pi-presence-subagents` — `presence-source.ts` (~449) + the `GenerationCheckpoint` port
  addition + the server wiring = ~470 lines, 16 tests. Consumes WU2a.

WU1 at ~660 is inside the budget but close to it; if review workload matters more than PR count,
its `memory-write-detector.ts` + its detector tests split off cleanly as well.

Strict TDD is `true` for this repository (`openspec/config.yaml`), so every task below that
introduces behaviour is written as a RED test first, then GREEN. `npm test`, `npm run typecheck`,
and `npm run lint:deps` MUST all be clean at the end of each work unit, not only at the end.

---

## Work Unit 1 — `pi-orchestrator-ingestion`

Goal: a live Pi session appears on the office floor with its real project path and live model. No
subagents yet.

### Phase 1: Harness identity

- [x] 1.1 RED: test asserting `HARNESS_IDS` contains `pi` and that the HTTP launch boundary accepts
      `pi` while still rejecting an unknown id.
- [x] 1.2 GREEN: add `'pi'` to `HARNESS_IDS` in `src/domain/events/types.ts`.
- [x] 1.3 Resolve the four now-incomplete `Record<HarnessId, …>` sites explicitly, with no `default`
      branch: `ui/components/atoms/badge.ts`, `ui/components/organisms/launch-control.ts`, and both
      records in `adapters/driven/launcher/build-launch-command.ts` (`HARNESS_BINARY.pi = 'pi'`,
      `DEFAULT_HARNESS_TEMPLATES.pi = []`).
- [x] 1.4 RED+GREEN: test asserting `buildLaunchCommand` for `pi` returns exactly `['pi']`
      (byte-identity, spec: Pi launches byte-identically).

### Phase 2: Discovery

- [x] 2.1 RED: `discover.test.ts` — filename `<iso-ts>_<uuid>.jsonl` yields `sessionKey`
      `pi:<uuid>`; a non-matching filename yields `null`.
- [x] 2.2 GREEN: `adapters/driven/pi/discover.ts` — `classifyPiSessionPath`, pure, no I/O.
- [x] 2.3 RED: test asserting `cwd` comes from the transcript's `session` record, and that a
      transcript with no `session` record yields `cwd: null`.
- [x] 2.4 GREEN: `resolvePiSessionCwd` reading a bounded file prefix, mirroring
      `codex/discover.ts`'s `resolveCodexSessionCwd`.
- [x] 2.5 RED: test asserting the directory-name encoding is never inverted — two fixture dirs whose
      names collide under the encoding still resolve to their own distinct `cwd` values.
- [x] 2.6 GREEN: `discoverPiSessions` scanning `<root>/sessions/*/*.jsonl` with the shared active
      window, plus `watchPiSessions` for newly added transcripts.

### Phase 3: Parsing

- [x] 3.1 RED: `parse.test.ts` — `parsePiLine` returns `null` for a truncated line and never throws.
- [x] 3.2 GREEN: `adapters/driven/pi/parse.ts` — `parsePiLine`, `classifyPiRecordFamily` over
      `session` / `model_change` / `thinking_level_change` / `custom` / `message`.
- [x] 3.3 RED: test asserting an assistant `toolCall` part becomes `tool_start` with a bounded
      `toolDetail`, and its matching `toolResult` becomes `tool_end` by `toolCallId`.
- [x] 3.4 GREEN: `resolvePiToolCaption` and `mapPiRecordToEvents`, with a per-session open-call map
      so `tool_end` correlates without scanning history.
- [x] 3.5 RED: test asserting `model_change` sets `agentProfile.model`, and that a transcript with
      neither `model_change` nor assistant `message.model` leaves `model` absent.
- [x] 3.6 GREEN: live model resolution.
- [x] 3.7 RED: `memory-write-detector.test.ts` — a `mem_save` `toolCall` emits `memory_write`
      *alongside* `tool_start`; a `bash` call emits only `tool_start`.
- [x] 3.8 GREEN: `PiMemoryWriteDetector`, taking Pi's own record type (Detector Interface Isolation).

### Phase 4: Source and wiring

- [x] 4.1 RED: `activity-source.test.ts` — `open()` emits a synthetic `session_start` first, carrying
      `projectPath` when `cwd` resolved, and `at === session.lastActivityAt`.
- [x] 4.2 GREEN: `PiActivitySource`, reusing `claude-code/tail.ts`'s `readTailIncrement` /
      `watchAndTailFile` unchanged.
- [x] 4.3 RED: `zero-write.test.ts` mirroring the four existing ones — a full cycle leaves content,
      mtime, and inode unchanged and creates no path.
- [x] 4.4 GREEN: confirm read-only by construction.
- [x] 4.5 Wire into `src/server.ts` behind `PI_ENABLED` and `PI_HOME` (default
      `~/.pi/agent`), following the existing per-harness enable pattern.
- [x] 4.6 Verify live: run the server against the real `~/.pi/agent/sessions` and confirm this
      repository's own Pi session renders with project `pixel-agents`.

---

## Work Unit 2 — `pi-presence-subagents`

Goal: Pi subagents appear as exact children of their orchestrator, with tool activity.

### Phase 5: Safe registry reader

- [x] 5.1 RED: `presence-read.test.ts` — a header whose filename disagrees with its own
      `sessionHash`/`incarnation` is skipped with reason `malformed`.
- [x] 5.2 RED: a digest mismatch between header and activity is skipped with reason
      `digest-mismatch`, and the reader continues with other activations.
- [x] 5.3 RED: a `generation` mismatch is skipped with reason `generation-mismatch`.
- [x] 5.4 RED: a symlink, a hard-linked file (`nlink > 1`), and an over-limit file are each rejected.
- [x] 5.5 RED: a device/inode change between `lstat` and `open` is rejected as `unsafe-file`.
- [x] 5.6 GREEN: `adapters/driven/pi/presence-read.ts` — bounded, `O_NOFOLLOW`, inode-pinned,
      digest-verified reads with counted skip reasons. Never throws.
- [x] 5.7 RED+GREEN: a header with `unavailable: 'activity-too-large'` publishes only `counts` as a
      `stats` event and never opens `activity.json`.

### Phase 6: Correlation

- [x] 6.1 RED: `correlate.test.ts` — a header whose `sessionHash` equals `sha256(sessionId)` of a
      known session produces `parent` linking `pi:task:<id>` to `pi:<sessionId>`.
- [x] 6.2 RED: an unknown `sessionHash` still publishes `session_start` for each task, invents no
      parent, and leaves the agent tree's orphan grace to promote it.
- [x] 6.3 GREEN: `adapters/driven/pi/correlate.ts` — a `Map<sha256, sessionId>` fed by transcript
      discovery, with a one-way hash lookup and no inversion attempt.
- [x] 6.4 RED+GREEN: `header.label` becomes `projectPath` only when it resolves to an existing
      absolute path; a bare project name leaves `projectPath` absent.

### Phase 7: Task events

- [x] 7.1 RED: first sighting of a task emits `session_start` with
      `agentProfile{role:'subagent', agentType, model, task}`, omitting each field the registry left
      empty.
- [x] 7.2 RED: a `status` change emits `status` carrying `lifecycle`, and never carries `activity`.
- [x] 7.3 RED: a thread `tool` item with `running: true` emits `tool_start`; the same `callId` with
      `running: false` emits `tool_end`; with `isError: true` that `tool_end` carries `reason`.
- [x] 7.4 RED: a terminal status additionally emits `session_end`.
- [x] 7.5 RED: every published event's `at` is the task's `lastActivityAt`, not the scan time.
- [x] 7.6 GREEN: `adapters/driven/pi/presence-source.ts` — `PiPresenceSource implements
      ActivitySource`, with the new `GenerationCheckpoint`.
- [x] 7.7 GREEN: add `GenerationCheckpoint` to `ports/activity-source.port.ts`'s `Checkpoint` union,
      documenting the two-currency split (`generation` decides when, `thread.version` decides which).
- [x] 7.8 RED+GREEN: `probe()` returns `ready` and discovery yields zero sessions when the presence
      directory does not exist, and no directory is created.
- [x] 7.9 Extend `zero-write.test.ts` to cover the presence tree.
- [x] 7.10 Wire `PiPresenceSource` into `src/server.ts` alongside `PiActivitySource`.
- [x] 7.11 Verify live: run a real `subagent_run`, confirm the child appears under its orchestrator.

---

## Work Unit 3 — `session-lifecycle-states`

Goal: the office draws what Pi reports. This is the only work unit that touches the domain and the
renderer.

### Phase 8: Domain

- [x] 8.1 RED: test asserting `SessionLifecycle` is derived from `SESSION_LIFECYCLES` and that no
      eighth member can be constructed.
- [x] 8.2 GREEN: add `SESSION_LIFECYCLES` / `SessionLifecycle` and the optional `lifecycle` field on
      `AgentEventBase` in `src/domain/events/types.ts`.
- [x] 8.3 RED: test asserting `lifecycle` and `activity` coexist on a worker without either being
      derived from the other.
- [x] 8.4 RED: test asserting an absent `lifecycle` is never defaulted to `'running'`.
- [x] 8.5 GREEN: project `lifecycle` onto the worker in `domain/office/office.ts`.

### Phase 9: Renderer

- [x] 9.1 RED: `office-view-model.test.ts` — a `queued` worker is not seated and not drawn working.
- [x] 9.2 RED: a `waiting` worker carries a blocked indicator; a plain idle worker carries none.
- [x] 9.3 RED: a `failed` worker surfaces its failure before removal; a `cancelled` one does not.
- [x] 9.4 RED: a worker with no `lifecycle` renders exactly as before, driven only by
      `SessionActivity`.
- [x] 9.5 GREEN: extend `ui/state/office-view-model.ts` and
      `ui/scene/character/animation-state.ts` with a total mapping over the closed lifecycle set.
- [x] 9.6 RED+GREEN: tooltip shows the Pi subagent's type, label, model, and lifecycle, omitting any
      field the registry did not report.
- [x] 9.7 Verify live in the browser: a queued subagent, a running one, and a failed one are each
      visually distinct.
      **THREE OF FOUR VERIFIED.** Done against a crafted presence-registry fixture holding one task
      per state, rendered in a real browser:
      - `running` — seated, captioned with its live tool (`bash`).
      - `queued` — present but not at a desk, captioned `sdd-verify`.
      - `waiting` — seated, carrying the amber blocked flag; its tooltip reads
        `Role: Subagent (review-risk) / Model: claude-sonnet-5 / Task: risk review / State: waiting`,
        confirming task 9.6 visually as well.
      - `failed` — **NOT OBSERVABLE, and this is a real gap, not a test artifact.** See below.

### Findings from live verification (open follow-ups)

- [ ] F1 **A failed subagent is never actually seen.** A terminal status emits `status(lifecycle)`
      and `session_end` in the same batch, so the office removes the worker in the same fold that
      learns it failed. The red indicator is correct in unit tests and unreachable on a real floor.
      Spec scenario "A failed subagent ends visibly, not silently" is therefore NOT satisfied by the
      current implementation. The fix is a dwell before removal — an animation-clock concern, which
      belongs in the render half next to `sofa-visit.ts`, not in the domain fold.
- [ ] F2 **A Pi subagent's project shows as `Unknown`.** `header.label` is a project name, not a
      path, so the source correctly refuses to publish it as `projectPath`. But the parent IS known
      whenever the hash resolves, so inheriting the orchestrator's `projectPath` through the
      resolved `parentSessionKey` would be a lookup, not a guess. Today the roster reports a
      phantom second project (`2 PROJECTS · 4 AGENTS`) for one real one.

---

## Rollback

Each work unit is an independent revert. `PI_ENABLED=false` disables all Pi ingestion at the
composition root without touching any other harness. Work Unit 3 is additive and optional: with it
reverted, Pi subagents still render, driven only by `SessionActivity`.
