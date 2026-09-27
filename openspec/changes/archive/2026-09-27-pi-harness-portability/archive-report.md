# Archive Report: pi-harness-portability

**Archive status: PASS (complete, with three recorded sync deviations — none destructive).**
Change moved to `openspec/changes/archive/2026-09-27-pi-harness-portability/`.

## 1. Native status consumed (authoritative)

`nextRecommended: archive`; `dependencies.archive: ready`; `dependencies.verify: ready`;
`applyState: all_done`; `taskProgress: 82/82, pending 0, allComplete true`; `blockedReasons: []`;
`notes: []`; `artifactStore: openspec`; `planningHome: repo-local` at this repository's
`openspec/`; `relationships.sameDomainActiveChanges: []`.

This is an authoritative, blocking-free status, so the non-authoritative store carve-out does not
apply and no `dependencies`/`blockedReasons` value had to be re-derived. The archive instructions
carried in the status object govern this phase and were followed: *"Archive records the actual task
state and any available verification findings; neither a report nor task completion is an admission
requirement"* and *"Preserve historical report and task bytes."*

`actionContext`: `mode: repo-local`, `workspaceRoot` and single `allowedEditRoot` both
`/Users/andresalvarez/Documents/pixel-agents`. Every path written by this phase is under
`openspec/` inside that root; nothing outside the repository was touched. The parent's confinement
instruction (no writes to `src/`, `scripts/`, `public/` or tests) was honoured — `git status` shows
only `openspec/` paths modified.

## 2. Preconditions

| Check | Result |
| --- | --- |
| Active change selection | Unambiguous — `pi-harness-portability`, the only active change |
| `proposal.md` | Present |
| Delta specs | Present, 4 domains, all multi-domain format (`specs/<domain>/spec.md`); no legacy flat `spec.md` |
| `design.md` | Present |
| `tasks.md` | Present, 82/82 complete |
| `verify-report.md` | **Missing — not blocking here** (see §3) |
| `apply-progress.md` | Missing — the tasks file is the record; `applyState: all_done` |
| `sync-report.md` | Absent before this phase → archive-time sync fallback used under explicit parent approval (see §4) |
| `openspec/config.yaml` `rules.archive` | "Warn before merging destructive deltas" — evaluated in §5 |
| Same-domain active changes | None |

## 3. Verification findings (no report file, but verification evidence exists)

There is no `verify-report.md`. The native status does not treat that as a blocker for archive, and
the repository does not lack verification — it lacks a verification *artifact*. The evidence lives in
`tasks.md`, in the parent's dispatch, and in git history:

- **Task 9.7 was honestly recorded as THREE OF FOUR VERIFIED**, with the fourth (a `failed`
  subagent) explicitly named "a real gap, not a test artifact". That gap became finding F1 and is the
  reason Work Unit 4 exists.
- **F1** — a terminal status emitted `status(lifecycle)` and `session_end` in one fold, so the office
  removed a worker in the same fold that learned it failed. Fixed by `28516d8`: a render-half dwell
  beside `sofa-visit.ts` holds a failed worker's last structural frame on the floor for 1.5s, reads
  the tick clock, clears on a re-used `sessionKey`, and leaves `domain/office/office.ts` untouched.
- **F2** — a Pi subagent's project read `Unknown`, manufacturing a phantom second project in the
  roster. Fixed by `957d4fb`: each session's real `cwd` is recorded beside the `sha256` join and
  resolved `hash -> path` merge-not-erase; the subagent's `session_start` carries the inherited path;
  late parent registration re-announces full identity exactly once; `presence-read.ts` deliberately
  unchanged.
- **F3** — a subagent's `mem_save` could never dock a file, because subagent activity lives only in
  the presence registry and that path emitted only `tool_start`/`tool_end`. Fixed by `5d19837`: the
  detector's tool-name regex became one shared exported predicate and `diffThread` emits
  `memory_write` alongside `tool_start`, gated by `runningCalls` so it fires once per call. `87fac88`
  separately corrected a stale `office.ts` module header.
- **Live verification closed 12.1 and 12.2.** Against a synthetic Pi home, the real server and a real
  Chrome driven over CDP: eight subagents failed one at a time put the failure indicator on the floor
  for ~9.4s (one to three indicators at different desks at once, matching a 1.5s dwell against a 1.5s
  stagger) and then removed it; the roster read `1 PROJECT · 9 AGENTS` with every `pi:task:*` carrying
  the inherited project path. Evidence recorded in `202fe5e` and `9d56a56`.
- **Final counts at close:** 1167/1167 tests across 100 files (baseline at change start: 1124),
  `npm run typecheck` clean, `npm run lint:deps` clean (222 modules, 782 dependencies). No FAIL,
  BLOCKED, or CRITICAL item is open anywhere in `tasks.md`.
- **Two method findings were kept from 12.2** and are environment, not product: restarting the backend
  while a client is connected silently freezes the SSE stream through vite's dev proxy (only a reload
  recovers); and in-page canvas readback returns a cleared buffer because `preserveDrawingBuffer` is
  false, so CDP screenshots are the only honest pixel evidence. The in-page red-pixel counter was
  discarded as a false negative rather than reported as a pass.

**No `verify-report.md` was invented by this phase.** Recording one after the fact would have created
verification authority this phase does not hold.

## 4. Task completion gate

Re-read of the persisted tasks artifact immediately before any sync or move: 82 lines matching
`^\s*- \[x\]`, **zero** lines matching `^\s*- \[ \]`. No stale-checkbox reconciliation was needed and
none was performed — `tasks.md` bytes are preserved exactly as `9d56a56` left them.

## 5. Sync performed at archive time

Approved by the parent's dispatch ("Follow the dependency graph: archive composes applicable delta
specs, retains task truth, and records archive history"). Full detail in `sync-report.md`, which now
travels with the archive.

| Domain | ADDED | MODIFIED | REMOVED |
| --- | --- | --- | --- |
| `agent-launcher` | — | Supported Launch Targets | — |
| `normalized-event-model` | Session Lifecycle Is Distinct From Activity | *authored* "Harness Identity Is A Closed Set", **applied as ADD** (D1) | — |
| `harness-log-ingestion` | Pi Orchestrator Session Discovery · Pi Transcript Record Families · Pi Subagent Presence Registry · Pi Parent/Child Correlation By Session Hash · Pi Subagent Lifecycle Events · Pi Zero-Write Guarantee · Pi memory_write Detection · **Pi Subagent Project Inheritance (composed)** · **Pi Subagent memory_write From The Presence Registry (composed)** | — | — |
| `office-scene-renderer` | Lifecycle-Distinct Worker Presentation · Pi Subagent Tooltip Detail | — | — |

Diffstat: 440 insertions, 5 deletions across 4 canonical specs. Post-merge structural checks clean:
no duplicate requirement headings, every requirement carries requirement text and at least one
scenario.

### F2 and F3: composed, not reported missing

**Both were composed.** The parent offered that choice explicitly and archive-time composition is the
lesser distortion here: leaving them out would have frozen into `openspec/specs/` two requirements that
contradict tested, shipped behaviour on `main` (a subagent with no project path; a subagent `mem_save`
that never docks). Each was written in the existing house style — RFC 2119 `MUST`/`MUST NOT` with
Given/When/Then scenarios — and pinned to the guard tests that already exist:

- **Pi Subagent Project Inheritance** — 4 scenarios: inherited resolved parent path; unresolvable
  parent leaves `projectPath` absent; merge-not-erase when a `cwd` reading fails; late parent
  re-announces identity once. Covers the parent's two required truths (inherit the resolved parent's
  path; absence of a resolvable parent leaves the path absent rather than guessed) and adds the
  merge-not-erase and once-only re-announcement rules that `957d4fb` actually implements.
- **Pi Subagent memory_write From The Presence Registry** — 5 scenarios: a subagent `mem_save` emits
  `memory_write` beside `tool_start` and reaches the office state; the event carries **no**
  `title`/`topicKey`/`observationType` and invents none from the tool name; exactly one emission per
  call across repeated scans; the MCP-prefixed `mcp__engram__mem_save` spelling matches the same
  single predicate; `bash`/`read`/`edit` never emit it.

**F1 needed no composition** — the delta already carries the scenario "A failed subagent ends visibly,
not silently", which `28516d8` satisfies. The 1.5s dwell duration, tick-clock basis, and
`sessionKey`-reuse clearing are implementation parameters recorded in §3 of this report rather than
promoted into new canonical requirements, because the parent stated F1 is covered and did not ask for
more.

## 6. Destructive merge guard

- REMOVED requirements: **none**. No canonical block was deleted.
- MODIFIED requirement names: **one** — `Supported Launch Targets`, ~3 lines replaced by ~20, and the
  replacement retains the canonical scenario verbatim. Nothing was lost, so no destructive-merge
  approval was required and none was needed from the parent.
- The single `MUST`-level narrowing anywhere in the merge is the reclassification in D1, which is
  additive. No MODIFIED delta was partial, so no scenario was silently dropped.
- `rules.archive` "Warn before merging destructive deltas": not triggered. The warnings that *are*
  recorded are in §7.

## 7. Known staleness carried into the canonical specs

Two legacy enumerations now read narrower than what ships. Both were deliberately **not** edited,
because the parent forbade weakening or deleting existing requirements and neither was addressed by a
delta for this change. They are reported rather than silently corrected:

1. **`harness-log-ingestion` → Global No-Write Invariant** still says "across all four adapters" and
   lists four home directories. This is not a falsehood about Pi: the merged spec now also carries a
   separate `Pi Zero-Write Guarantee` covering `~/.pi/`, proved by a fifth `zero-write.test.ts`. The
   enumeration is merely ungeneralised.
2. **`memory-write-visualization` → Detector Interface Isolation** still says "the four `memory_write`
   detectors ... with no shared pattern-matching logic between them". There are now five, and F3's fix
   made the Pi transcript detector and the Pi presence path share **one** tool-name predicate — which
   is a deliberate exception to "no shared pattern-matching logic", not a violation of its intent
   (isolation across *harnesses* still holds; the sharing is within the Pi harness). This is the one
   place where shipped behaviour and a legacy canonical sentence are in real tension. Generalising
   that requirement, and moving `Pi memory_write Detection` into the `memory-write-visualization`
   domain where the other four live, is a legitimate follow-up change with its own delta — not an
   archive-time edit.

Also noted, not acted on: `office-scene-renderer` → Parent/Child Lane Layout names only "Claude Code
and OpenCode", but its scenario is harness-agnostic and Pi subagents satisfy it (verified live in
12.2). Antigravity was already unlisted there, so this is pre-existing, not introduced here.

## 8. Delivery state at close

Everything is on `main`, published to `origin/main` at `a7a0bef`; `main` is the only branch locally and
remotely. Delivery was a five-PR stack (#37–#41) fast-forwarded into `main` with all branches deleted:
#37 merged (GitHub marked it when the commits landed), #38–#41 closed with an explanation because
retargeting a stacked PR after a fast-forward is not possible. The review budget in `tasks.md` (700
production lines per work unit, tests/fixtures excluded) was recorded as exceeded by WU2 at ~860 and
split into WU2a/WU2b for that reason; WU4 measured ~1580 production lines across the change against an
original ~1000–1200 forecast.

## 9. Next recommendation

`next_recommended: none` for this change — it is archived and its capability deltas are merged. The
repository's own native status will re-derive from the surviving active changes. Two follow-ups are
worth opening as new changes rather than as edits to this archive:

- Generalise the two legacy count-bearing requirements in §7 (single small delta across
  `harness-log-ingestion` and `memory-write-visualization`).
- The deferred click-to-inspect panel over presence `thread` items, named as out-of-scope in the
  proposal and left as the reason `text`/`thinking` items are parsed then discarded.

## 10. Audit trail

Artifacts read: `proposal.md`, `design.md`, `tasks.md`, and the four delta specs; canonical specs for
all five domains; `openspec/config.yaml`; `sync-report.md` was absent (confirmed, not skipped).

Artifacts written by this phase, all inside `openspec/`:

- `openspec/changes/pi-harness-portability/sync-report.md` (new)
- `openspec/changes/pi-harness-portability/archive-report.md` (this file, new)
- `openspec/specs/agent-launcher/spec.md`
- `openspec/specs/harness-log-ingestion/spec.md`
- `openspec/specs/normalized-event-model/spec.md`
- `openspec/specs/office-scene-renderer/spec.md`

Nothing was committed. The untracked `.pi/` directory and every file belonging to the in-progress
work unit elsewhere in the repository were left untouched and are not part of anything above.

`proposal.md`, `design.md`, `tasks.md` and the four delta specs were moved byte-for-byte to
`openspec/changes/archive/2026-09-27-pi-harness-portability/`. No active artifact was deleted.
