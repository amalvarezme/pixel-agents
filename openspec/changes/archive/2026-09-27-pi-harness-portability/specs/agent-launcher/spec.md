# Agent Launcher Specification

## MODIFIED Requirements

### Requirement: Supported Launch Targets

The system MUST support launching `claude`, `codex`, `opencode`, `agy` (Antigravity CLI), and `pi`
as plain processes, and MUST NOT offer a launch affordance for the Antigravity IDE.

The Pi launch template MUST remain empty, so a launched Pi session's command line is byte-identical
to the user typing `pi` themselves, preserving the Zero-Injection Spawn Invariant.

#### Scenario: Antigravity IDE has no launch affordance

- GIVEN the office scene displays an ingested Antigravity IDE session
- WHEN the user views that session in the scene
- THEN no launch control is presented for it

#### Scenario: Pi launches byte-identically to a manual invocation

- GIVEN a user would manually run `pi` with no extra flags in a given directory
- WHEN the launcher spawns a Pi session for that same directory
- THEN the resulting argv is exactly `['pi']`
- AND no configuration file under `~/.pi/` is created or modified by the launcher

#### Scenario: Pi is offered as a launch target

- GIVEN the launch control renders one button per supported target
- WHEN the view is built
- THEN a Pi target is present with its own label
- AND the set of targets is exactly the five supported harnesses
