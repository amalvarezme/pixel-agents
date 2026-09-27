# Normalized Event Model Specification

## MODIFIED Requirements

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

## ADDED Requirements

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
