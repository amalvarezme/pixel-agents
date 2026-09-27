# Sync Report: pi-harness-portability

Executed at archive time as the file-backed sync step, under explicit parent approval in the archive
dispatch ("archive composes applicable delta specs, retains task truth, and records archive history").
No `sdd-sync` phase ran before this archive, so this is the archive-time sync fallback. The Final Task
Completion Gate passed first: `tasks.md` holds 82 `- [x]` and zero `- [ ]`.

- Synced on: 2026-09-27
- Delta source: `openspec/changes/pi-harness-portability/specs/<domain>/spec.md`
- Canonical target: `openspec/specs/<domain>/spec.md`
- Domains in the delta: `agent-launcher`, `harness-log-ingestion`, `normalized-event-model`,
  `office-scene-renderer`
- Domains NOT touched: `memory-write-visualization` (no delta for that domain in this change)

## Per-domain result

### `agent-launcher` — 1 MODIFIED

| Operation | Requirement | Result |
| --- | --- | --- |
| MODIFIED | Supported Launch Targets | Replaced in full by the delta block |

The delta block retained the canonical `Antigravity IDE has no launch affordance` scenario verbatim and
added `Pi launches byte-identically to a manual invocation` and `Pi is offered as a launch target`. No
scenario was dropped, so this MODIFIED is non-destructive: +20 / -3 lines.

### `normalized-event-model` — 1 reclassified, 1 ADDED

| Operation (as authored) | Requirement | Applied as |
| --- | --- | --- |
| MODIFIED | Harness Identity Is A Closed Set | **ADDED** — see Deviation D1 |
| ADDED | Session Lifecycle Is Distinct From Activity | ADDED |

### `harness-log-ingestion` — 7 ADDED from the delta, 2 composed at sync time

| Operation | Requirement |
| --- | --- |
| ADDED | Pi Orchestrator Session Discovery |
| ADDED | Pi Transcript Record Families |
| ADDED | Pi Subagent Presence Registry |
| ADDED | Pi Parent/Child Correlation By Session Hash |
| ADDED | Pi Subagent Lifecycle Events |
| ADDED | Pi Zero-Write Guarantee |
| ADDED | Pi memory_write Detection |
| ADDED (**composed, not in any delta**) | Pi Subagent Project Inheritance |
| ADDED (**composed, not in any delta**) | Pi Subagent memory_write From The Presence Registry |

The two composed requirements carry the shipped, live-verified behaviour of findings F2 and F3, which
postdate the delta specs. Without them the canonical ingestion spec would have described a subagent
whose project is `Unknown` and whose Engram saves never dock a file — i.e. it would have been false
about `main`. Placement follows the delta's own convention of putting Pi ingestion behaviour,
including `Pi memory_write Detection`, in this domain rather than in `memory-write-visualization`.

### `office-scene-renderer` — 2 ADDED

| Operation | Requirement |
| --- | --- |
| ADDED | Lifecycle-Distinct Worker Presentation |
| ADDED | Pi Subagent Tooltip Detail |

Finding F1 needed no composed requirement: its shipped dwell behaviour is what makes the delta scenario
"A failed subagent ends visibly, not silently" true, and that scenario was carried over unchanged.

## Deviations recorded

- **D1 — a MODIFIED requirement had no canonical target.** `Harness Identity Is A Closed Set` is
  authored under `## MODIFIED Requirements` but does not exist in `openspec/specs/normalized-event-model/spec.md`
  (that spec's five requirements are Canonical Event Type Set, Event Origination Provenance,
  Parent/Child Correlation Field Contract, Event Envelope Common Fields, Per-Session Ordering
  Guarantee). Strictly this is a block condition. It was resolved as an ADD because the block is
  wholly additive in substance — it takes a four-id closed set to five ids, keeps the "derived from one
  `const` array" rule and the "sessionKey prefixed by harness id" rule, and adds two scenarios without
  removing anything. Nothing was lost by the reclassification; a canonical requirement with that name
  simply never existed. A corrected delta would have listed it under `## ADDED Requirements`.
- **D2 — sync-time composition of two new requirements** (F2, F3) into `harness-log-ingestion`, on the
  parent's explicit instruction. These are the only requirements in any canonical spec whose text was
  not authored by the change's own delta files.
- **D3 — Purpose enumerations widened by one word each.** `harness-log-ingestion` Purpose now reads
  "five harnesses (Claude Code, Codex, OpenCode, Antigravity, Pi)" and `agent-launcher` Purpose lists
  `` `pi` `` among the spawn targets. No requirement statement, scenario, or `MUST` was altered. This
  was done only where the delta itself changed the harness set; leaving them at "four" would have put a
  false summary above the newly-synced Pi requirements.

## Legacy text preserved byte-identical

No requirement was REMOVED or weakened. The pre-existing count-bearing lines were left untouched and
verified still present after the merge:

- `harness-log-ingestion` — "across all four adapters", "any of the four adapters", "the other three
  adapters continue operating unaffected"
- `agent-launcher` — "any of the four supported harnesses", "the four ingestion adapters"
- `normalized-event-model` — "any of the four ingestion adapters processes a harness record"
- `memory-write-visualization` — "the four `memory_write` detectors", "the same logic path used for the
  other three"

See the archive report, section "Known staleness carried into the canonical specs", for the two places
where those legacy enumerations now read narrower than what shipped, and why fixing them belongs to a
later change rather than to archive-time sync.

## Post-sync structural checks

- Requirement counts after merge: agent-launcher 5, harness-log-ingestion 17,
  memory-write-visualization 6 (untouched), normalized-event-model 7, office-scene-renderer 8.
- No duplicated `### Requirement:` heading in any canonical spec.
- Every requirement in every canonical spec has non-empty requirement text and at least one
  `#### Scenario:`.
- Diffstat: 440 insertions, 5 deletions across 4 files.
