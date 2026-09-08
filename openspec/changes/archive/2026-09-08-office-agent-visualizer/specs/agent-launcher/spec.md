# Agent Launcher Specification

## Purpose

Spawn harness sessions (Claude Code, Codex, OpenCode, `agy`) with zero injection into the
harness's own configuration or invocation, strictly separated from the read-only ingestion
subsystem.

## Requirements

### Requirement: Zero-Injection Spawn Invariant

The system MUST spawn a harness process without adding `--append-system-prompt`, without a
custom `--settings` argument, and without mutating any harness configuration file. The user's
existing configuration MUST stand unmodified.

#### Scenario: Launched command line matches manual launch

- GIVEN a user would manually run `claude` with no extra flags in a given directory
- WHEN the launcher spawns a Claude Code session for that same directory
- THEN the resulting command line is byte-identical to the manual invocation
- AND no `--append-system-prompt` or `--settings` argument is present

#### Scenario: No harness config file is touched by a launch

- GIVEN the launcher spawns any of the four supported harnesses
- WHEN the spawned process starts and produces its own session log
- THEN no harness config file, hook file, or settings file has been created or modified by the
  launcher itself

### Requirement: Self-Originated Launch Events Only

The system MUST emit `launch_requested` when a launch is initiated from the scene and
`launch_started` once the process has been spawned, both originating exclusively from the
launcher's own process state, never parsed from any harness log file.

#### Scenario: launch_requested precedes launch_started

- GIVEN a user triggers a launch action in the office scene
- WHEN the launcher accepts the request and then spawns the process
- THEN a `launch_requested` event is emitted first, followed by a `launch_started` event
- AND neither event's data is derived from reading a harness log file

### Requirement: Subsystem Separation from Ingestion

The system MUST implement the launcher as a subsystem with no shared code path with any
ingestion adapter, even though both publish onto the same normalized event bus.

#### Scenario: Launcher change does not require touching an adapter

- GIVEN the launcher's spawn mechanism is modified
- WHEN the four ingestion adapters are exercised against their existing fixtures
- THEN their behavior and code are unaffected

### Requirement: Supported Launch Targets

The system MUST support launching `claude`, `codex`, `opencode`, and `agy` (Antigravity CLI) as
plain processes, and MUST NOT offer a launch affordance for the Antigravity IDE.

#### Scenario: Antigravity IDE has no launch affordance

- GIVEN the office scene displays an ingested Antigravity IDE session
- WHEN the user views that session in the scene
- THEN no launch control is presented for it

### Requirement: Unavailable Harness CLI Handling

The system MUST report a specific, actionable failure when a requested harness CLI is not
present on `PATH`, rather than silently failing or emitting `launch_started` for a process that
never started.

#### Scenario: Missing CLI reported, not silently dropped

- GIVEN `agy` is not present on the user's `PATH`
- WHEN the user requests an Antigravity launch
- THEN `launch_requested` is emitted, followed by a failure signal identifying the missing
  binary
- AND `launch_started` is never emitted for this attempt
