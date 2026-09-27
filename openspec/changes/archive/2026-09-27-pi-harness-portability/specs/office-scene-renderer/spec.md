# Office Scene Renderer Specification

## ADDED Requirements

### Requirement: Lifecycle-Distinct Worker Presentation

The system MUST render a worker's reported `SessionLifecycle` as a visually distinguishable state,
so that a subagent waiting in a queue is never drawn as one doing work. The mapping MUST be total
over the closed lifecycle set and MUST NOT fall back to a default appearance for an unrecognised
member, since the set is closed at compile time.

A worker whose lifecycle is absent MUST render exactly as it did before lifecycle existed, driven
only by `SessionActivity`.

#### Scenario: A queued subagent does not appear to be working

- GIVEN a subagent worker whose last `status` event carried `lifecycle: 'queued'`
- WHEN the scene renders that worker
- THEN it is drawn in a non-working posture, away from a desk
- AND it is visually distinguishable from a worker with `lifecycle: 'running'`

#### Scenario: A blocked subagent is distinguishable from an idle one

- GIVEN a subagent worker with `lifecycle: 'waiting'`
- AND another subagent worker with no lifecycle and `activity: 'idle'`
- WHEN the scene renders both
- THEN the `waiting` worker carries a distinct blocked indicator
- AND the plain idle worker carries none

#### Scenario: A failed subagent ends visibly, not silently

- GIVEN a subagent worker whose final `status` carried `lifecycle: 'failed'`
- WHEN the scene processes its `session_end`
- THEN the failure is surfaced before the worker is removed
- AND a `cancelled` worker is removed without a failure indication

#### Scenario: Lifecycle absent renders exactly as before

- GIVEN a Claude Code worker, from a harness that reports no lifecycle
- WHEN the scene renders it
- THEN its appearance is determined only by its `SessionActivity`
- AND no lifecycle indicator is drawn

### Requirement: Pi Subagent Tooltip Detail

The system MUST present, in the hover tooltip for a Pi subagent worker, its subagent type, its task
label, its model, and its lifecycle state. Each field MUST be omitted rather than defaulted when the
presence registry did not report it.

#### Scenario: Pi subagent tooltip shows its registry-reported identity

- GIVEN a Pi subagent task with `agent: "sdd-apply"`, `label: "apply work unit 2"`, `model: "claude-sonnet-5"`, `status: "running"`
- WHEN the user hovers that worker
- THEN the tooltip shows the subagent type, the task label, the model, and `running`
- AND the project row shows the orchestrator's project

#### Scenario: A field the registry omitted is absent from the tooltip

- GIVEN a Pi subagent task whose `model` is an empty string in the registry
- WHEN the user hovers that worker
- THEN no model row is rendered
- AND no placeholder or guessed model is shown
