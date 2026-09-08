# Office Scene Renderer Specification

## Purpose

Render a 2D "office" scene from the normalized event stream: one worker per active agent, correct
parent/child layout, and an archive destination that a worker visits on `memory_write`.

## Requirements

### Requirement: Per-Agent Worker Mapping

The system MUST render exactly one worker for each distinct active session ID present in the
normalized event stream, appearing on `session_start` and disappearing on `session_end`.

#### Scenario: Worker appears and disappears with session lifecycle

- GIVEN a `session_start` event for session `S1`
- WHEN the scene processes this event
- THEN a worker representing `S1` appears in the scene
- AND when a subsequent `session_end` event for `S1` arrives, that worker is removed

### Requirement: Parent/Child Lane Layout

The system MUST render Claude Code and OpenCode parent/child sessions in visually distinct lanes,
using the correlation field defined by the normalized event model's `parent` events.

#### Scenario: Subagent renders in a child lane

- GIVEN a `parent` event correlates child session `C1` to parent session `P1`
- WHEN the scene renders both sessions
- THEN `C1`'s worker appears in a lane visually distinct from `P1`'s lane
- AND the lane assignment is driven by the `parent` event's correlation field, not by a
  harness-specific field

### Requirement: Single-Agent Layout

The system MUST render a single, uncluttered layout when only one session is active, with no
lane subdivision applied.

#### Scenario: One active session, no lanes shown

- GIVEN only one `session_start` event has occurred with no matching `parent` event
- WHEN the scene renders
- THEN the single worker is shown without any parent/child lane division

### Requirement: Multi-Agent Layout

The system MUST render multiple concurrent sessions, correlated or not, without visual overlap
that would make individual workers indistinguishable.

#### Scenario: Multiple independent sessions render distinctly

- GIVEN three `session_start` events for unrelated sessions `S1`, `S2`, `S3` with no `parent`
  correlations among them
- WHEN the scene renders
- THEN three distinct, non-overlapping workers are visible

### Requirement: Archive Destination Rendering

The system MUST render a fixed archive destination in the scene and MUST animate the worker for
the originating session traveling to that destination whenever a `memory_write` event for that
session is received.

#### Scenario: Worker travels to archive on memory_write

- GIVEN a `memory_write` event is received for session `S1`, whose worker is currently at its
  default position
- WHEN the scene processes this event
- THEN `S1`'s worker animates a path to the fixed archive destination

### Requirement: Worker Label Resolution

The system MUST resolve a worker's display label by preferring first-class harness fields where
available (OpenCode `session.agent`, Antigravity `toolAction`/`toolSummary`), and MUST treat
Claude Code's `attributionAgent` as a best-effort label with a deterministic fallback when absent.

#### Scenario: OpenCode uses first-class agent column as label

- GIVEN an OpenCode session with `session.agent == "observador"`
- WHEN the scene renders that session's worker
- THEN the worker's label is `observador`

#### Scenario: Missing attributionAgent falls back deterministically

- GIVEN a Claude Code sidechain session with no `attributionAgent` field present
- WHEN the scene renders that session's worker
- THEN a deterministic default label is shown instead of a blank or error label
