# Memory Write Visualization Specification

## Purpose

Detect an Engram `mem_save` call on each of the four harnesses, using one distinct detector per
harness behind a shared interface, and drive the office scene's archive animation from the
resulting `memory_write` event.

## Requirements

### Requirement: Claude Code memory_write Detection

The system MUST emit a `memory_write` event when a Claude Code `tool_use` record's `name` matches
`mcp__*engram*__mem_save`, covering both observed spellings `mcp__engram__mem_save` and
`mcp__plugin_engram_engram__mem_save`.

#### Scenario: Direct MCP spelling detected

- GIVEN a `tool_use` record with `name: "mcp__engram__mem_save"`
- WHEN the Claude Code detector processes it
- THEN it emits one `memory_write` event

#### Scenario: Plugin-wrapped spelling detected

- GIVEN a `tool_use` record with `name: "mcp__plugin_engram_engram__mem_save"`
- WHEN the Claude Code detector processes it
- THEN it emits one `memory_write` event

### Requirement: Codex memory_write Detection

The system MUST emit a `memory_write` event when a Codex `event_msg`/`item_completed` record has
`payload.item.type == "McpToolCall"` with `server == "engram"` and `tool == "mem_save"`. The
detector MUST NOT match on the unrelated `custom_tool_call` record family (`name: "exec"`), which
represents sandboxed code execution, not an MCP call.

#### Scenario: McpToolCall for mem_save detected

- GIVEN an `event_msg`/`item_completed` record with `item.type: "McpToolCall"`, `server: "engram"`,
  `tool: "mem_save"`
- WHEN the Codex detector processes it
- THEN it emits one `memory_write` event

#### Scenario: custom_tool_call exec record does not false-positive

- GIVEN a `response_item` record with `payload.type: "custom_tool_call"`, `name: "exec"`, and
  free-text `input`/`output` that happens to contain the substring `mem_save`
- WHEN the Codex detector processes it
- THEN no `memory_write` event is emitted
- AND the record is recognized as sandboxed code execution, not an MCP tool call

### Requirement: OpenCode memory_write Detection

The system MUST emit a `memory_write` event when an OpenCode `part` row has
`part.tool == "engram_mem_save"`, using the harness's `<server>_<tool>` naming convention with no
`mcp__` prefix.

#### Scenario: engram_mem_save part detected

- GIVEN a `part` row with `data->>'$.type' == "tool"` and `data->>'$.tool' == "engram_mem_save"`
- WHEN the OpenCode detector processes it
- THEN it emits one `memory_write` event

#### Scenario: Similarly-named non-Engram tool does not match

- GIVEN a `part` row with `data->>'$.tool' == "context7_query-docs"`
- WHEN the OpenCode detector processes it
- THEN no `memory_write` event is emitted

### Requirement: Antigravity memory_write Detection

The system MUST emit a `memory_write` event when a `tool_calls[]` entry has `name == "call_mcp_tool"`
AND, after stripping one layer of literal surrounding quote characters from `args.ServerName` and
`args.ToolName`, those values equal `engram` and `mem_save` respectively. A naive equality
comparison against the raw (quoted) values MUST fail to match.

#### Scenario: Double-encoded values correctly de-quoted and matched

- GIVEN a `tool_calls[]` entry `{"name": "call_mcp_tool", "args": {"ServerName": "\"engram\"",
  "ToolName": "\"mem_save\"", "Arguments": "{\"title\":\"x\"}"}}`
- WHEN the Antigravity detector strips the surrounding quote characters from `ServerName` and
  `ToolName` before comparing
- THEN the comparison matches `engram` and `mem_save`
- AND the detector emits one `memory_write` event

#### Scenario: Naive equality against raw quoted value fails

- GIVEN the same record as above
- WHEN a comparison checks `args.ServerName == "engram"` without stripping quotes first
- THEN the comparison is false, because the raw value is the 8-character string `"engram"`
  including its quote characters
- AND this scenario documents why de-quoting is mandatory, not optional

### Requirement: Detector Interface Isolation

The system MUST implement the four `memory_write` detectors as independent units behind one
shared interface, with no shared pattern-matching logic between them.

#### Scenario: One detector's change does not affect another

- GIVEN the Codex detector logic changes to accommodate a new Codex record shape
- WHEN the Claude Code, OpenCode, and Antigravity detectors are exercised against their own fixtures
- THEN their behavior is unaffected by the Codex-specific change

### Requirement: memory_write Drives Archive Animation Trigger

The system MUST treat every `memory_write` event, regardless of source harness, as the sole and
sufficient trigger for the office scene's archive animation, with no additional harness-specific
condition required downstream of the event.

#### Scenario: Any harness's memory_write triggers the same animation

- GIVEN a `memory_write` event is emitted with harness identifier `antigravity`
- WHEN the scene layer receives this event
- THEN it triggers the archive animation using the same logic path used for the other three
  harnesses
