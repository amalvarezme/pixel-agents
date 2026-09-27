# Normalized Event Model Specification

## Purpose

Define one harness-agnostic event schema and stream contract that every adapter emits into,
decoupling the office scene renderer from any single harness's log format.

## Requirements

### Requirement: Canonical Event Type Set

The system MUST define exactly eleven normalized event types: the prior art's eight
(`session_start`, `tool_start`, `tool_end`, `message`, `stats`, `status`, `parent`, `session_end`)
plus three new types (`memory_write`, `launch_requested`, `launch_started`).

#### Scenario: Adapter emits only defined event types

- GIVEN any of the four ingestion adapters processes a harness record
- WHEN it emits a normalized event
- THEN the event's type is one of the eleven canonical types
- AND no adapter emits an event type outside this set

### Requirement: Event Origination Provenance

The system MUST distinguish, at the schema level, between ingestion-sourced event types (all
eight prior-art types plus `memory_write`) and self-originated event types (`launch_requested`,
`launch_started`), which MUST NEVER be produced by parsing a harness log.

#### Scenario: launch_requested never comes from a log parse

- GIVEN an ingestion adapter is tailing a harness log file
- WHEN the adapter processes any record in that file
- THEN it never emits a `launch_requested` or `launch_started` event
- AND those two types are only emitted by the launcher subsystem

### Requirement: Parent/Child Correlation Field Contract

The system MUST expose a stable, harness-agnostic correlation field (parent session ID, child
session ID) on `parent` events, derived only from load-bearing source fields
(`toolUseResult.agentId` for Claude Code, `session.parent_id` for OpenCode), and MUST NOT derive
this correlation from any undocumented display-only field.

#### Scenario: Correlation excludes attributionAgent

- GIVEN a Claude Code sidechain record carries both `agentId` and `attributionAgent`
- WHEN the normalized `parent` event is constructed
- THEN the correlation field is populated from `agentId`
- AND `attributionAgent`, if present, is carried only as an optional display label

### Requirement: Event Envelope Common Fields

Every normalized event MUST carry: harness identifier, session ID, event type, a timestamp, and
an optional correlation ID, regardless of source harness.

#### Scenario: Events from different harnesses share envelope shape

- GIVEN one `tool_start` event from Claude Code and one `tool_start` event from Codex
- WHEN both are placed on the event stream
- THEN both expose the same envelope fields (harness identifier, session ID, type, timestamp)
- AND a consumer can process both without harness-specific branching on the envelope

### Requirement: Per-Session Ordering Guarantee

The system MUST deliver events for a given session ID in the order they were produced by that
session's source (log line order for JSONL harnesses, `event.seq` order for OpenCode).

#### Scenario: OpenCode events delivered in seq order

- GIVEN OpenCode's `event` table contains rows with `seq` values 10, 11, 12 for one session
- WHEN the adapter polls and emits normalized events
- THEN they are emitted in ascending `seq` order
- AND no event is skipped or delivered out of order

### Requirement: Harness Identity Is A Closed Set

The system MUST model harness identity as a closed set of five ids: `claude-code`, `codex`,
`opencode`, `antigravity`, `pi`. The type MUST be derived from a single `const` array so the runtime
guard and the compile-time type cannot drift. Every exhaustive mapping keyed by harness id MUST
resolve all five members explicitly, and MUST NOT use a `default` or fallback branch.

Every `sessionKey` MUST be prefixed with its harness id, so two harnesses can never collide in the
same key space.

#### Scenario: A fifth harness is accepted by the ingest boundary

- GIVEN the HTTP launch boundary validates an incoming harness id against the closed set
- WHEN the id `pi` arrives
- THEN it is accepted
- AND an unknown id such as `cursor` is still rejected

#### Scenario: Pi session keys are namespaced

- GIVEN a Pi orchestrator session with id `S` and one of its subagent tasks with id `t1`
- WHEN both are published
- THEN their keys are `pi:S` and `pi:task:t1`
- AND neither can collide with any other harness's key space

### Requirement: Session Lifecycle Is Distinct From Activity

The system MUST model a session's scheduler-reported lifecycle separately from its liveness
projection. `SessionActivity` (`working` / `idle`) MUST remain owned exclusively by the session
lifecycle coordinator and MUST NOT be set by any ingestion adapter.

`SessionLifecycle` MUST be a closed set derived from a single `const` array, with members `running`,
`queued`, `waiting`, `completed`, `failed`, `cancelled`, `timed_out`. It MUST be carried as an
optional field on `status` events. A harness that reports no lifecycle MUST leave the field absent,
and every consumer MUST treat an absent lifecycle as "no claim", never as `running`.

#### Scenario: Lifecycle and activity coexist without overwriting each other

- GIVEN a subagent published with `lifecycle: 'waiting'` by an ingestion adapter
- WHEN the lifecycle coordinator later marks the same session `activity: 'idle'`
- THEN both facts are retained on the worker
- AND neither field was derived from the other

#### Scenario: Absent lifecycle is not defaulted

- GIVEN a Claude Code `status` event, from a harness with no lifecycle signal
- WHEN the office state applies it
- THEN the worker's lifecycle remains absent
- AND it is not set to `running`

#### Scenario: An ingestion adapter cannot claim liveness

- GIVEN any Pi ingestion adapter publishing a `status` event
- WHEN that event is constructed
- THEN it carries `lifecycle`
- AND it does not carry `activity`
