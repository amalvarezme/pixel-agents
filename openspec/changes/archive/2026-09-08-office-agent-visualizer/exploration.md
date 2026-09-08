# Exploration: office-agent-visualizer

> Mirror of Engram topic `sdd/office-agent-visualizer/explore` (observation #934).
> Phase: `sdd-explore`. Artifact store: hybrid (OpenSpec + Engram).

## Current State

Greenfield workspace. The only prior artifact is `comparativa-harnesses-agentes.md`, which already
settled the architecture category: passive log readers (category B) are chosen over hook-based
visualizers (category A), because hooks are Claude-Code-only and rewrite `~/.claude/settings.json`
(where Engram's `SessionStart` hook lives). This exploration does not relitigate that decision. It
verifies, against real files on this machine, whether category B is actually implementable for all
four target harnesses (Claude Code, Codex, OpenCode, Antigravity) and for the two extra requirements
layered on top of the research doc: agent launching (#3) and Engram memory-write visualization (#6).

All findings below were obtained by reading real files (plus one web search for OpenCode's
documented storage migration), not by inference from the comparativa doc.

## Affected Areas (real event sources on disk)

- `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl` — Claude Code main session transcript.
- `~/.claude/projects/<slugified-cwd>/<session-id>/subagents/agent-<agentId>.jsonl` — Claude Code
  Task/subagent transcripts: physically separate files nested under the parent session's directory.
- `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` — Codex session transcript.
- `~/.codex/history.jsonl` — Codex lightweight prompt index only, not a full event source.
- `~/.codex/*.sqlite` — exist and are real, but unnecessary and out of scope for category B.
- `~/.local/share/opencode/opencode.db` (+ `-wal`/`-shm`) — the ONLY place OpenCode session,
  message and token data lives in this install. `storage/` holds no session data.
- `~/.local/share/opencode/log/*.log` — human-readable operational logs, not machine session events.
- `~/.gemini/antigravity-ide/brain/<conversation-uuid>/.system_generated/logs/transcript.jsonl` —
  Antigravity per-conversation, per-step JSON transcript including tool calls.
- `~/.gemini/antigravity-ide/conversations/<uuid>.db` — separate SQLite index; not needed.
- `~/.antigravity/` — only `argv.json` and `extensions/extensions.json`; no hooks, no settings
  equivalent.

## Findings by requirement

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Compatible with Claude Code, Codex, Antigravity, OpenCode | Feasible for Claude Code, Codex and Antigravity via confirmed JSONL schemas. OpenCode is the outlier: no file-based session log exists in this install, only SQLite. | Per-harness sections below. |
| 2 | Passive log reader, no hooks, no config writes | Feasible for 3/4 harnesses by pure file read. OpenCode forces a choice between read-only SQLite access and its SSE `/event` endpoint. Neither writes, but reading a live SQLite file is a stricter gray zone than reading JSONL. | `storage/**` glob returned exactly one non-session file; `opencode.db`/`-wal`/`-shm` present. |
| 3 | Launch agents/subagents from the visualizer | Architecturally clean IF the launcher is a separate, explicit, user-triggered subprocess/PTY spawn with zero injection (no `--append-system-prompt`, no custom `--settings`), never mutating harness config or log files. | A zero-injection Claude Code session was observed running Engram's `SessionStart` hook normally, with no visualizer-side injection. |
| 4 | Compatible with gentle-ai and Engram | The same "spawn plain" principle avoids the munder-difflin contract-collision failure mode (N parallel sessions each loading the global orchestrator contract plus competing `--append-system-prompt`). Not applicable if the visualizer never injects prompts. | Comparativa doc analysis, corroborated by an observed zero-injection session. |
| 5 | Visualize steps in single- and multi-agent mode | Claude Code: parent/child linkage is recoverable. Subagent files live under the parent session directory, every record carries `isSidechain: true` plus `agentId`, and the `agentId` also appears inside the parent transcript. Codex/OpenCode: single-thread evidence only in the samples read. Antigravity: single-thread step decomposition observed; no sub-agent primitive found. | Direct JSONL reads. |
| 6 | Animate Engram `mem_save` to a specific archive location | Confirmed feasible for Claude Code with hard evidence, by reading the harness's OWN log. No access to Engram's internal store is needed. For Codex/OpenCode/Antigravity it is inference-only until a real `mem_save` call is captured in each of their logs. | Verbatim `tool_use`/`tool_result` pair, see below. |

## Per-harness evidence detail

### Claude Code

JSONL Lines, each record type-discriminated: `last-prompt`, `mode`, `permission-mode`, `attachment`
(hook results, e.g. `SessionStart:startup`), `file-history-snapshot`, `user`, `assistant`.
Assistant messages carry `message.content[].type` of `text` | `thinking` | `tool_use`; `tool_use`
has `name` (e.g. `mcp__engram__mem_save`, `Read`) and `input`. Tool results come back as a `user`
record with a `tool_result` content block plus a mirrored `toolUseResult` field. Threading fields:
`sessionId`, `cwd`, `gitBranch`, `version`, `uuid`, `parentUuid`.

Subagent (Task) sessions are separate files at
`<project-dir>/<parent-session-id>/subagents/agent-<agentId>.jsonl`. Every line carries
`"isSidechain": true` and `"agentId": "<hash>"` matching the filename. Subagent assistant messages
also carry `"attributionAgent": "<phase-or-skill-name>"`, useful directly as the "office worker"
label — but its stability across Claude Code versions is unverified.

### Engram `mem_save` detection (the requirement #6 answer)

Observed verbatim in a live transcript under
`.claude/projects/-Users-andresalvarez-Documents-pixel-agents/<session>/subagents/agent-<id>.jsonl`:

```
{"type":"tool_use","name":"mcp__engram__mem_save","input":{"title":"sdd-init/pixel-agents", ...},"caller":{"type":"direct"}}
...
{"tool_use_id":"...","type":"tool_result","content":[{"type":"text","text":"{\"id\":929,\"result\":\"Memory saved: ...\",\"state\":\"active\",\"sync_id\":\"obs-...\"}"}]}
```

Both `mcp__engram__mem_save` (direct MCP) and `mcp__plugin_engram_engram__mem_save`
(plugin-wrapped install) occur in this workspace's logs. A passive reader must match both, and
generically `mcp__*engram*__mem_save`.

### Codex

`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. First record is
`{"timestamp":...,"ordinal":0,"type":"session_meta","payload":{"session_id":...,"cli_version":...,"originator":"codex-tui","model_provider":"openai","base_instructions":{"text":"## Engram Persistent Memory — Protocol\n...","provenance":{"type":"custom"}},"git":{...}}}`.

`base_instructions` carries the full Engram protocol verbatim as injected prompt text: this is how
Engram integrates with Codex, since Codex has no hooks. Subsequent record types confirmed:
`event_msg`/`task_started`, `response_item`/`message`/`input_text`, `turn_context`, `world_state`,
`reasoning`. No MCP tool-call record was found in the sampled lines, so the exact Codex tool-call
record shape for a real `mem_save` invocation remains unverified.

### OpenCode

A glob of `~/.local/share/opencode/storage/**` returned exactly one file,
`storage/oh-my-opencode-slim/tui-state.json`, a plugin-local UI blob rather than session history.
The real data lives in `~/.local/share/opencode/opencode.db` plus `-wal`/`-shm` (WAL mode present).
Documentation corroborates that since OpenCode 1.2 all chat history and token usage metadata are
persisted in `opencode.db`, with automatic migration from legacy JSON storage.

**This invalidates the prior art's design premise.** `office-for-claude-agents` deliberately avoids
OpenCode's SQLite in favor of file-based logs, but in this installed version there is no file-based
session log left to read instead.

The same source describes an HTTP `/event` SSE endpoint on OpenCode's server process, session-scoped
via query parameter. That endpoint is a plausible category-B-compliant path (read-only subscribe, no
direct SQLite open) but requires `opencode serve` to be running and needs schema verification.

### Antigravity

`~/.gemini/antigravity-ide/brain/<uuid>/.system_generated/logs/transcript.jsonl` is a real,
structured, per-line JSON transcript. Verified shape:

```
{"step_index":N,"source":"USER_EXPLICIT"|"SYSTEM"|"MODEL","type":"USER_INPUT"|"CONVERSATION_HISTORY"|"KNOWLEDGE_ARTIFACTS"|"EPHEMERAL_MESSAGE"|"PLANNER_RESPONSE"|"VIEW_FILE"|"CODE_ACTION","status":"DONE","created_at":ISO8601,"content":"...","thinking":"...","tool_calls":[{"name":"view_file"|"write_to_file","args":{...}}]}
```

This corrects the comparativa doc's "zero native support" framing: no existing visualizer supports
Antigravity, but the artifact a category-B reader needs already exists and is directly parseable.
No shim is required for basic step and tool-call visualization. No multi-agent primitive was found;
Antigravity's own task decomposition is single-thread planning, so requirement #5's multi-agent mode
may simply not apply there.

## Approaches — stack fork (deliberately not decided)

| Option | Pros | Cons | Effort |
|---|---|---|---|
| **A. Node/TypeScript** + `node-pty` + `chokidar` + Canvas/PixiJS web UI | Same stack as the prior art and munder-difflin, minus Electron; largest PTY/JSONL ecosystem; local HTTP server plus browser tab avoids Electron entirely | Node runtime and npm supply-chain surface | Medium |
| **B. Go** + `creack/pty` + `fsnotify` + embedded JS/canvas frontend | Matches the existing Go investment (gentle-ai is Go); single static binary; no Node dependency for the backend | Still needs an embedded JS/canvas frontend for 2D animation, so it becomes a hybrid regardless; weaker native animation ecosystem | Medium-High |
| **C. Rust** + `portable-pty` + `notify` + web frontend | Best fit if composing directly with herdr; smallest single binary | Highest iteration friction for an animated 2D UI; smallest maintenance pool | High |

## Recommendation

Proceed to `sdd-propose` carrying these settled facts forward:

1. Category B (passive reader) remains correct and is now verified per-harness, not merely asserted.
2. Requirement #6 is solved for Claude Code with a verbatim on-disk `tool_use`/`tool_result` pair.
   No Engram-internal store access is needed. Treat the other three harnesses as inference-only
   until a real `mem_save` call is captured in each of their logs.
3. The launch feature (#3) must be a genuinely separate, zero-injection subprocess/PTY spawn, never
   folded into the passive read path and never touching harness config. PTY is required for the
   three CLI harnesses; Antigravity is a GUI app and needs a different launch verb (open/focus a
   window), designed explicitly rather than forced into one abstraction.
4. OpenCode requires an explicit decision: read `opencode.db` read-only (gray zone against the
   "never touch a harness SQLite" rule) versus subscribing to its SSE `/event` endpoint (cleaner,
   but requires a running server and schema verification).
5. Normalized event model: extend the prior art's eight event types (`session_start`, `tool_start`,
   `tool_end`, `message`, `stats`, `status`, `parent`, `session_end`) with a `memory_write` event
   (emitted when a `tool_use` record name-matches `mcp__*engram*__mem_save`) and a separate
   `launch_requested`/`launch_started` pair originating from our own process, never from a harness log.
6. Stack: the A/B/C fork stays open for the user to decide.

## Risks

- OpenCode's session storage has fully migrated to SQLite; the prior art's file-based fallback no
  longer exists. Needs an explicit decision.
- Codex's tool-call record shape for a real `mem_save` invocation was not directly observed.
- Antigravity's multi-agent primitive, if any, is unverified; requirement #5 may not apply there.
- Claude Code's `attributionAgent` field is observed but undocumented; do not treat it as a stable
  public contract without further confirmation.
- PTY-vs-GUI asymmetry across the four harnesses (three terminal CLIs, one VS Code fork) means
  "launch" needs two distinct verbs, not one abstraction.
- Never open any harness `*.sqlite`/`*.db` for write; even read access must be timed carefully,
  since WAL files can be locked by a running harness process.

## Ready for Proposal

Yes. Two explicit open decisions must be resolved first: the OpenCode read path (read-only SQLite
versus SSE) and the runtime/UI stack (options A, B or C above).
