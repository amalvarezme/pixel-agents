# Research: local disk evidence for office-agent-visualizer

> SDD phase: `sdd-research`, local-evidence lane. Mirrors Engram topic
> `sdd/office-agent-visualizer/research-local-evidence`. Companion lane: external/web
> evidence (separate document). This lane touches only files already on this machine.

## Answer first

All five research questions are now resolved with quoted, on-disk evidence. The
single biggest update since `sdd-explore` (#934): **Codex's MCP tool-call record
shape is now CONFIRMED**, including a real `mem_save` call — it was missed
before only because the sampled session's tool calls live under
`event_msg`/`item_completed`, a record family the earlier pass did not grep for.
OpenCode's `part.tool` column also turns out to name MCP tools with a
`<server>_<tool>` convention (e.g. `engram_mem_save`) and its `event` table
gives a clean, strictly-monotonic per-session `seq` for incremental polling.
Antigravity remains the one harness where `mem_save` is still unobserved on
this machine, across every available CLI and IDE transcript.

| # | Question | Status |
|---|---|---|
| Q1 | Codex MCP tool-call shape | **CONFIRMED** — real `mem_save` call found |
| Q2 | Antigravity `agy` multi-agent + transcript schema | **CONFIRMED** (`agy agents` is a backend RPC, not local); no multi-agent primitive found |
| Q3 | OpenCode `opencode.db` schema | **CONFIRMED** — full schema, tool naming, polling column |
| Q4 | Claude Code record-type completeness | **CONFIRMED** — exhaustive counts across 528 files |
| Q5 | Engram `mem_save` detectability per harness | 3/4 CONFIRMED, Antigravity UNVERIFIED |

---

## Q1. Codex MCP tool-call record shape — CONFIRMED

**This corrects exploration.md #934.** Only one Codex session file exists on
this machine at all:
`~/.codex/sessions/2026/08/23/rollout-2026-08-23T12-59-40-01a02fc7-3a34-7443-a79a-3ced988a0f20.jsonl`
(45 lines). The earlier exploration pass grepped for `function_call` /
`local_shell_call` / `response_item` tool records and found none, and
concluded the shape was unverified. It IS present — under a different
top-level record family the earlier pass didn't check: `event_msg` /
`item_completed`, whose `payload.item.type` is `"McpToolCall"`.

Confirmed record shape, quoted verbatim (line 39, `ordinal: 38`):

```json
{"timestamp":"2026-08-23T18:00:25.470Z","ordinal":38,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a02fc7-3a34-7443-a79a-3ced988a0f20","turn_id":"01a02fc7-59ff-7d42-abc2-76e2374256cc","item":{"type":"McpToolCall","id":"exec-c3c8ae88-7772-431a-a649-3b932441ddec","server":"engram","tool":"mem_save","arguments":{"project":"from-chat-to-cognitive-system","scope":"project","type":"config","title":"Verified Gentle AI and Engram availability","topic_key":"config/gentle-ai-engram","content":"**What**: Verified that Gentle AI 2.4.0 is installed and Engram memory tools are active in this Codex session.\n**Why**: The user asked whether both systems are being used.\n**Where**: Codex session for /Users/andresalvarez/Documents/from-chat-to-cognitive-system.\n**Learned**: Gentle AI is available at /opt/homebrew/bin/gentle-ai; Engram successfully resolved the current project and returned prior session context."},"readOnlyHint":false,"status":"completed","result":{"content":[{"type":"text","text":"{\"id\":803,\"judgment_required\":false,\"project\":\"from-chat-to-cognitive-system\",\"project_path\":\"\",\"project_source\":\"explicit_override\",\"result\":\"Memory saved: \\\"Verified Gentle AI and Engram availability\\\" (config)\",\"state\":\"active\",\"sync_id\":\"obs-e96cb4029c60a54c\"}"}]},"duration":{"secs":0,"nanos":32937042}},"started_at_ms":1787508025437,"completed_at_ms":1787508025470}}
```

Same shape recurs twice earlier in the same file for read-only calls:
- Line 29 (`ordinal: 28`): `"item":{"type":"McpToolCall","server":"engram","tool":"mem_current_project","arguments":{},"readOnlyHint":true,...}`
- Line 30 (`ordinal: 29`): `"item":{"type":"McpToolCall","server":"engram","tool":"mem_context","arguments":{"project":"from-chat-to-cognitive-system","scope":"project"},"readOnlyHint":true,...}`

**Detection recipe for a passive Codex reader**: parse every `event_msg` line,
check `payload.type == "item_completed"`, then `payload.item.type ==
"McpToolCall"`. The tool name is a bare `payload.item.tool` (e.g. `"mem_save"`)
alongside an explicit `payload.item.server` (e.g. `"engram"") — Codex does
**not** use Claude Code's `mcp__<server>__<tool>` single-string naming; server
and tool are separate JSON fields. `readOnlyHint: false` on `mem_save` versus
`true` on the read-only calls is a free signal for filtering writes.
`tool_start`/`tool_end` in the normalized event model map to
`started_at_ms`/`completed_at_ms` inside the same record (Codex emits the call
and its result as one already-completed item, not as a start/end pair).

A second, unrelated tool-call family also exists in Codex logs and must not be
confused with MCP calls: local shell execution surfaces as `event_msg` /
`item_completed` with `item.type: "CommandExecution"` (fields: `command`,
`cwd`, `stdout`, `exit_code`, `duration`), and a separate sandboxed-exec
mechanism surfaces as `response_item` records with `payload.type:
"custom_tool_call"` / `"custom_tool_call_output"` (`name: "exec"`, freeform
`input`/`output` script text) — this is Codex running an inline JS/Python
snippet, not an MCP call, and it is what the earlier exploration's
`custom_tool_call` grep hit was actually showing.

## Q2. Antigravity `agy` CLI — multi-agent primitive and transcript schema — CONFIRMED

### Why `agy agents` returns empty

`agy agent`/`agy agents --help` both resolve to the same help text ("List
available agents"), and running `agy agents` bare exits `0` with no output —
not an error. `strings ~/.local/bin/agy` explains why: the subcommand is
backed by a **remote RPC**, not a local file read —

```
v1internal_go_proto.ListAgentsRequest
v1internal_go_proto.ListAgentsResponse
/v1internal:listAgents
google.internal.cloud.code.v1internal.ListAgentsRequest
```

(the binary's internal codename is "Jetski CLI": `google3/third_party/jetski/cli/entrypoints/entrypoints.listAgentsMode`).
So `agy agents` calls an internal Google Cloud Code backend endpoint
(`ListAgents`) that returns whatever named agent configurations exist for the
authenticated account/project; on this machine none are configured
server-side, so the response is legitimately empty, not a broken command. This
is **not inspectable from local files or `--help` alone** — it requires
backend account state we cannot read from disk.

No local `agents.json` or equivalent agent-definition file exists anywhere
under `~/.gemini/antigravity-cli/` (checked `builtin/`, `implicit/` — the
latter holds two opaque `.pb` protobuf blobs, not agent lists — and the
directory tree at large). `builtin/skills/` and the plugin-provided
`skills/` directory hold Markdown skill definitions (SDD skills, etc.), which
are a separate concept from "agents".

Separately, `agy mcp list` — which DOES read local state — shows only:
```
NAME       TYPE   STATUS   COMMAND/URL
codegraph  stdio  enabled  /Users/andresalvarez/.npm-global/bin/codegraph serve --mcp
graphify   stdio  enabled  /Users/andresalvarez/Documents/chec-local-uiti-vano-interpreter/.venv/bin/python3 -m graphify.serve
```
while `~/.gemini/antigravity-cli/mcp_config.json` (a separate file) declares:
```json
{"mcpServers": {"context7": {"serverUrl": "https://mcp.context7.com/mcp"}, "engram": {"args": ["mcp"], "command": "/opt/homebrew/bin/engram"}}}
```
`agy mcp list`'s live output and `mcp_config.json`'s static declaration
disagree (engram/context7 appear in the file but not in the live listing) —
this workspace's Antigravity MCP wiring is in a state that needs clarifying
before designing the Antigravity adapter's server-name detection, since
`agy mcp list` is presumably the source of truth for what is actually loaded.

The binary's Go symbols also confirm a **different**, unrelated internal
concept exists: `SubagentSpec`, `HasSubagents`, `GetSubagents` — these are
protobuf message/field names for a sub-agent capability, but no runtime
evidence of it firing was found in any sampled transcript (see below). This is
a compiled-in capability, not confirmed active multi-agent behavior.

### `transcript.jsonl` vs `transcript_full.jsonl`

Only **one** Antigravity CLI conversation exists on this machine:
`~/.gemini/antigravity-cli/brain/f4c9f259-58a9-45b3-9cba-411400f4b195/.system_generated/logs/`.
Both files are present there, and they are **byte-identical** (same MD5
`5bdbbe390636dd926d3824a94214da43`, both 2726 bytes, 4 lines each). The
conversation contains a `CHECKPOINT` record (`step_index: 3`) whose boilerplate
text says *"The earlier parts of this conversation have been truncated...
reference `transcript.jsonl` for the full conversation"* — but in this specific
4-line session nothing was actually truncated yet, which is consistent with
`_full` and the plain file matching exactly. **Conclusion (sample size 1,
flagged as such): `transcript_full.jsonl` is the CLI's un-truncated superset,
written alongside `transcript.jsonl` once a conversation grows long enough to
checkpoint/compact; when no compaction has happened yet, the two files are
identical.** No CLI conversation with actual divergence between the two files
was found on this machine to confirm the delta's exact shape.

### CLI vs IDE surface — schema comparison

The **IDE** surface has 16 conversation directories under
`~/.gemini/antigravity-ide/brain/<uuid>/.system_generated/logs/`, and **none of
them have a `transcript_full.jsonl` file at all** — only `transcript.jsonl`.
So `_full` is CLI-only on this machine; the IDE adapter only ever has one file
to read.

Where both surfaces DO have `transcript.jsonl`, the per-line schema is
identical in shape (`step_index`, `source`, `type`, `status`, `created_at`,
optional `content`/`thinking`/`tool_calls`) — same field names, same nesting.
**This means one adapter can cover both surfaces for `transcript.jsonl`**; the
only surface-specific handling needed is that CLI conversations may
additionally carry a `transcript_full.jsonl` and IDE conversations never do.

### Populated `tool_calls` example (IDE)

Quoted verbatim from
`~/.gemini/antigravity-ide/brain/bdd0233c-fda1-4974-85db-483f2aae1672/.system_generated/logs/transcript.jsonl`:

```json
{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-06-15T20:23:35Z","thinking":"**Prioritizing Tool Usage**\n\n...","tool_calls":[{"name":"list_dir","args":{"DirectoryPath":"\"/Users/andresalvarez/Documents/chec-local-uiti-vano-interpreter\"","toolAction":"\"Listing workspace directory\"","toolSummary":"\"Workspace directory listing\""}}]}
```

Enumerating every distinct `tool_calls[].name` across all 16 IDE transcripts
(954 to a few thousand lines each) gives exactly this closed set, all
IDE-native editor actions — **no MCP-namespaced tool name appears anywhere**:

```
view_file (274)  run_command (235)  replace_file_content (115)  grep_search (111)
write_to_file (76)  schedule (63)  multi_replace_file_content (57)  manage_task (45)
list_dir (40)  search_web (2)  read_url_content (1)
```

No `engram`/`mem_save`/`mem_search`/`mem_context` string appears in any of the
16 IDE transcripts, nor in the one CLI transcript (which has no `tool_calls`
at all — its 4 lines are a plain Q&A turn). See Q5 for the requirement #6
verdict this implies.

### `mcp/` directory and `log/cli-*.log`

`~/.gemini/antigravity-cli/mcp/` contains only one server's local
cache/instructions: `mcp/codegraph/codegraph_explore.json` and
`mcp/codegraph/instructions.md`. No `engram` subdirectory exists there despite
`mcp_config.json` declaring it.

The three files under `~/.gemini/antigravity-cli/log/cli-*.log` are plain
operational/debug logs (Go `logging before google.Init` style lines). Grepping
all three for `mcp` (case-insensitive) returns **zero matches** — MCP server
invocation is not traced in these files at all. The one `engram` hit found
(`cli-20260823_125819.log:168`) is just an echoed user prompt
(`HandleUserInput called with text: "usas gentle-ai y engram?"`), not a tool
invocation. **Conclusion: these `.log` files are not a usable signal for MCP
tool-call detection**; the transcript JSON (`tool_calls[]`) is the only
avenue, and on this machine it has never captured an Engram call.

## Q3. OpenCode `opencode.db` schema — CONFIRMED (via scratchpad copy only)

Per the safety rule, `opencode.db` (73,891,840 bytes), `opencode.db-wal`
(32,768 bytes) and `opencode.db-shm` (32,768 bytes) were copied into
`/private/tmp/claude-501/-Users-andresalvarez-Documents-pixel-agents/217c58b5-15f9-4d6b-8607-3a82a3ad511c/scratchpad/`
and every query below ran against that copy only. The live files under
`~/.local/share/opencode/` were never opened.

### Full schema

19 tables: `workspace`, `data_migration`, `account_state`, `account`,
`control_account`, `credential`, `event_sequence`, `event`, `permission`,
`project_directory`, `project`, `message`, `part`,
`session_context_epoch`, `session_input`, `session_message`, `session`,
`todo`, `session_share`, plus a bare `migration` table.

Relevant tables in full:

```sql
CREATE TABLE `session` (
  `id` text PRIMARY KEY, `project_id` text NOT NULL, `workspace_id` text,
  `parent_id` text, `slug` text NOT NULL, `directory` text NOT NULL,
  `path` text, `title` text NOT NULL, `version` text NOT NULL,
  `share_url` text, `summary_additions` integer, `summary_deletions` integer,
  `summary_files` integer, `summary_diffs` text, `metadata` text,
  `cost` real DEFAULT 0 NOT NULL, `tokens_input` integer DEFAULT 0 NOT NULL,
  `tokens_output` integer DEFAULT 0 NOT NULL, `tokens_reasoning` integer DEFAULT 0 NOT NULL,
  `tokens_cache_read` integer DEFAULT 0 NOT NULL, `tokens_cache_write` integer DEFAULT 0 NOT NULL,
  `revert` text, `permission` text, `agent` text, `model` text,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL,
  `time_compacting` integer, `time_archived` integer,
  FOREIGN KEY(`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
CREATE TABLE `message` (
  `id` text PRIMARY KEY, `session_id` text NOT NULL,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL,
  FOREIGN KEY(`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
CREATE TABLE `part` (
  `id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL,
  FOREIGN KEY(`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
CREATE TABLE `event` (
  `id` text PRIMARY KEY, `aggregate_id` text NOT NULL, `seq` integer NOT NULL,
  `type` text NOT NULL, `data` text NOT NULL,
  FOREIGN KEY(`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `event_aggregate_seq_idx` ON `event` (`aggregate_id`,`seq`);
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);
```

Cost/token stats live directly on `session` (`cost`, `tokens_input`,
`tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`)
— no separate stats table.

### Tool-call representation and MCP distinguishability

Session/message content is a JSON blob in `data`; `part` rows carry a
`type` discriminator. Distinct `part.data->>'$.type'` values and counts:
`tool` (1520), `step-start` (983), `step-finish` (979), `reasoning` (719),
`text` (539), `patch` (84), `file` (6), `subtask` (1).

Among `type = "tool"` parts, `data->>'$.tool'` is the tool's bare name and
**MCP tools ARE distinguishable by name**: OpenCode namespaces them as
`<mcp-server-name>_<tool-name>`, no `mcp__` prefix. Confirmed Engram tool
names actually seen: `engram_mem_judge` (75), `engram_mem_search` (45),
`engram_mem_save` (43), `engram_mem_get_observation` (33),
`engram_mem_current_project` (18), `engram_mem_context` (6),
`engram_mem_save_prompt` (5), `engram_mem_session_summary` (3),
`engram_mem_update` (1), `engram_mem_doctor` (1) — alongside other MCP
servers' tools in the same namespacing style (`crossref_crossref_search_works`,
`openalex_openalex_search_entities`, `semanticscholar_search_papers`,
`arxiv_arxiv_search`, `context7_resolve-library-id`, `context7_query-docs`).
Built-in (non-MCP) tools use short bare names: `read` (477), `bash` (264),
`grep` (89), `edit` (85), `glob` (81), `write` (56), `todowrite` (51),
`task` (37), `skill` (33), `webfetch` (24), `question` (14),
`apply_patch` (13).

One full `engram_mem_save` part row, quoted verbatim:

```json
{"type":"tool","tool":"engram_mem_save","callID":"call_4JNJWAbi6rznWip97bj2WY4O","state":{"status":"completed","input":{"project":"andresalvarez","title":"Verified Engram wiring in OpenCode","type":"discovery","content":"**What**: Verified that OpenCode has Engram MCP configured and reachable, and identified a separate local Engram plugin adapter file.\n**Why**: Needed to check whether Gentle AI OpenCode currently has Engram functionality working.\n**Where**: ~/.config/opencode/opencode.json, ~/.config/opencode/opencode.jsonc, ~/.config/opencode/plugins/engram.ts; Engram doctor for project andresalvarez.\n**Learned**: Engram MCP is enabled in config and the doctor reports healthy operation. The plugin adapter file exists, but it is not listed in the visible plugin array, so its runtime loading cannot be confirmed from config alone."},"output":"{\"id\":1,\"judgment_required\":false,\"project\":\"andresalvarez\",\"project_path\":\"\",\"project_source\":\"explicit_override\",\"result\":\"Memory saved: \\\"Verified Engram wiring in OpenCode\\\" (discovery)\\nSuggested topic_key: discovery/verified-engram-wiring-in-opencode\",\"state\":\"active\",\"sync_id\":\"obs-b02e864ccbbf2418\"}","metadata":{"truncated":false},"title":"","time":{"start":1783042239442,"end":1783042239485}},"metadata":{"openai":{"itemId":"fc_0dd509077776af9c016a4710bddbdc8193ae7e3f6357734091"}}}
```

### Parent/child (sub-agent) relationships

`session.parent_id` is a real, populated column. 36 of 67 sessions have a
non-null `parent_id`. Sample:

```
id                              parent_id                       agent       title
ses_0fe19e814ffebuL56onTnmm4st  ses_0fe1b77e0ffewQB3yfHFgnnXcv  general     Extract graph chunk 1 (@general subagent)
ses_0fdda691effeTfB5noUxDjV8X5  ses_0fde25c0bffeP6UX6Ef0Tjtd4s  observador  Fase 0: Observador ingesta insumos (@observador subagent)
```
`session.agent` names the sub-agent persona directly (e.g. `general`,
`observador`), directly usable as an "office worker" label — cleaner than
Claude Code's `attributionAgent`, since it is a first-class column rather than
an inferred per-message field.

### Incremental polling column

Two independent monotonic signals exist, either sufficient for polling:
1. **`event.seq`** — a per-`aggregate_id` (session) strictly monotonic integer
   with a `UNIQUE(aggregate_id, seq)` index. A reader can store
   `last_seq_seen[session_id]` and query `WHERE aggregate_id = ? AND seq >
   ? ORDER BY seq`. Confirmed event types and counts:
   `message.part.updated.1` (9982), `message.updated.1` (4223),
   `session.updated.1` (1294), `session.created.1` (67),
   `session.next.model.switched.1` (23), `session.next.agent.switched.1` (3).
2. **`message`/`part` composite** — both tables carry `time_created` (integer
   epoch-ms) plus a lexicographically-sortable `id` (e.g.
   `msg_f00f36290001JDnIK5oStP62b1`, whose prefix appears to embed a
   time-ordered component), and `message` has a purpose-built index
   `(session_id, time_created, id)` for exactly this kind of tailing query.

Either path answers the design question: **yes, OpenCode supports incremental
polling without re-reading the whole database.**

### Row counts (data volume)

```
event: 15592      part: 4831      message: 1135     session: 67
event_sequence: 67  todo: 40      session_message: 26  project: 4
project_directory: 3  migration: 38
(workspace, account*, credential, permission, session_context_epoch,
 session_input, session_share: 0 rows each on this machine)
```

## Q4. Claude Code record-type completeness — CONFIRMED

### Complete top-level `type` distribution

Parsed every line of all 528 `~/.claude/projects/**/*.jsonl` files as JSON
(173,278 lines total, **0 parse errors**) and tallied only the record's
top-level `type` key (a naive text grep, as tried first, wrongly counts nested
JSON-schema type strings like `"string"`/`"boolean"` and nested Engram
observation types like `"decision"`/`"bugfix"` that live inside `tool_use`
inputs — those are noise, not record types). The true, complete, exhaustive
list is exactly 18 values:

| type | count |
|---|---|
| assistant | 57,507 |
| attachment | 45,939 |
| user | 34,393 |
| last-prompt | 6,395 |
| mode | 6,284 |
| permission-mode | 6,282 |
| ai-title | 6,188 |
| system | 2,678 |
| atis-latch | 2,569 |
| queue-operation | 2,002 |
| file-history-snapshot | 1,063 |
| file-history-delta | 854 |
| relocated | 351 |
| worktree-state | 351 |
| frame-link | 305 |
| cost-state | 62 |
| artifact-autoreact-ledger | 33 |
| artifact-comment-monitor | 22 |

### Parent references child: exact record

Located a subagent transcript
(`.../-Users-andresalvarez-Documents-chec-local-uiti-vano-interpreter/5efdf36b-8bcc-4dd5-ab2c-420057c05101/subagents/agent-aeb024e25f517d93b.jsonl`)
and grepped the parent session file for the same `agentId`. The parent
carries it inside the `tool_result`/`toolUseResult` record returned for the
launch call (parent file line 3064):

```json
{"parentUuid":"ac2bf472-04a9-4f8c-9f92-649c2dcbfb67","isSidechain":false,"promptId":"1637e735-8c02-48e0-8de5-b0c5fd513426","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01EbudmpBvkez2dsnR1bXLn4","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully. ... agentId: aeb024e25f517d93b ..."}]}]},"uuid":"cfa2625e-36ee-4442-91fc-f727986962f8","timestamp":"2026-08-14T20:06:02.725Z","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"aeb024e25f517d93b","description":"Auditar camino Windows apps","resolvedModel":"claude-opus-5[1m]", ...}}
```

`toolUseResult.agentId` is the load-bearing field: it is a plain, structured
string, not something that needs parsing out of prose. A passive reader can
match child transcript filenames (`agent-<agentId>.jsonl`) directly against
this field to draw the parent→child edge.

### `attributionAgent` stability across versions

26 distinct Claude Code `version` strings appear across the corpus, from
`2.1.223` to `2.1.263` (semver-like `2.1.x` build numbers; a handful of
one-off timestamp-hash strings like `1788704681-0393` also appear once each
and belong to a different tool/context, not this field). `attributionAgent`
was cross-referenced against every `isSidechain: true` (subagent) record:

- It is present on **17,034 of 17,062** sidechain `assistant` records (99.8%)
  — i.e., essentially every subagent model-output line carries it.
- It never appears on sidechain `user` or `attachment` records (10,042 +
  2,827 such records checked, zero hits) — by design, since only model
  outputs need an attribution label.
- Restricting to versions that have **any** sidechain records at all, the
  match is exact: `attributionAgent` appears in precisely the same 12
  versions that have subagent activity in this dataset — `2.1.232, 2.1.233,
  2.1.234, 2.1.235, 2.1.237, 2.1.241, 2.1.246, 2.1.247, 2.1.258, 2.1.259,
  2.1.261, 2.1.263`. The other 14 sampled versions (`2.1.223–2.1.231` except
  232, `2.1.238, 2.1.243, 2.1.245, 2.1.248, 2.1.251, 2.1.252, 2.1.257`) simply
  never launched a subagent in this dataset — their absence is a sampling
  gap, not evidence the field was removed in those builds.

Quoted example (top-level field, not nested under `message`):

```json
{"parentUuid":"cf3e88c0-1a7c-4b1f-8814-5efbb1ae6f8b","isSidechain":true,"agentId":"a50ed6015d52cbd51","message":{"model":"claude-sonnet-5","role":"assistant","content":[...]},"requestId":"req_011Ce5NysprJPwVJkHnDeCxu","attributionAgent":"sdd-tasks","type":"assistant","uuid":"813f0276-6f89-4bc1-b170-d672b23b40..."}
```

**Verdict: stable across every version sampled where it could apply (12/12),
but still not proven present in the earliest or in several later versions
because no subagent ran there — treat as "present in every 2.1.x build that
uses subagents so far observed," not as a documented, version-pinned
guarantee.**

### Both Engram tool-name spellings, plus siblings

Both confirmed, with exact counts, across all 528 files:

```
238  mcp__engram__mem_save                              56  mcp__plugin_engram_engram__mem_save
 34  mcp__engram__mem_session_summary                     7  mcp__plugin_engram_engram__mem_session_summary
 19  mcp__engram__mem_judge                               6  mcp__plugin_engram_engram__mem_judge
 16  mcp__engram__mem_search                             14  mcp__plugin_engram_engram__mem_search
 11  mcp__engram__mem_get_observation                    17  mcp__plugin_engram_engram__mem_get_observation
  7  mcp__engram__mem_context                             2  mcp__plugin_engram_engram__mem_current_project
  2  mcp__engram__mem_update                              1  mcp__plugin_engram_engram__mem_update
```

A passive Claude Code reader must match `mcp__engram__*` OR
`mcp__plugin_engram_engram__*` (generically `mcp__.*engram.*__mem_save` for
the write-detection case specifically).

## Q5. Engram `mem_save` detectability, per harness

| Harness | Status | Evidence |
|---|---|---|
| Claude Code | **CONFIRMED** | `tool_use` name `mcp__engram__mem_save` / `mcp__plugin_engram_engram__mem_save`, paired `tool_result`; see Q4 and exploration.md #934. |
| Codex | **CONFIRMED** | `event_msg`/`item_completed`/`item.type:"McpToolCall"`, `server:"engram"`, `tool:"mem_save"`; see Q1, quoted in full above. |
| OpenCode | **CONFIRMED** | `part.data->>'$.type'='tool'`, `part.data->>'$.tool'='engram_mem_save'`; see Q3, quoted in full above. |
| Antigravity | **UNVERIFIED** | Searched all 16 IDE transcripts and the only CLI transcript (both plain and `_full` where present): zero occurrences of `engram`/`mem_save`/`mem_search`/`mem_context` anywhere, and the full closed set of `tool_calls[].name` values seen contains only IDE-native editor actions (`view_file`, `run_command`, etc.) — no MCP-namespaced name. `mcp_config.json` declares an `engram` MCP server for the CLI surface, and `~/.gemini/antigravity-cli/mcp/` has no cached instructions file for it (only `codegraph/` does), which is consistent with it never having been invoked on this machine. `agy mcp list`'s live output doesn't even list `engram` (only `codegraph`, `graphify`) — worth resolving before assuming the wiring is currently active at all. |

**Bottom line for requirement #6**: 3 of 4 harnesses are now proven with a
real, captured `mem_save` call. Antigravity is the one gap, and it is a gap in
*data*, not in design — the detection recipe (match a known MCP tool name
inside whatever the transcript's tool-call field is) is unambiguous once a
real Antigravity Engram call is captured. Recommend either: (a) deliberately
triggering one `mem_save` call from within an Antigravity CLI or IDE session
before design closes, or (b) shipping the Antigravity adapter's `memory_write`
detection as explicitly best-effort/inferred until a real example exists.

## Risks and open threads carried forward

- Antigravity's `agy mcp list` and `mcp_config.json` disagree on whether
  `engram` is actually wired for the CLI surface — resolve which one reflects
  reality before finalizing the Antigravity adapter's server-name matching.
- Antigravity's `SubagentSpec`/`HasSubagents` protobuf fields are compiled
  into the `agy` binary, but no runtime evidence of a multi-agent session was
  found in any of the 17 available transcripts (1 CLI + 16 IDE) — requirement
  #5 likely still does not apply to Antigravity, now on stronger evidence than
  the explore phase had.
- `agy agents` depends on an authenticated backend RPC (`ListAgents`); it is
  not something a local, offline passive reader can enumerate or rely on for
  discovering "who are the possible office workers" on this harness.
- OpenCode's `session.agent` column is a strictly better sub-agent label than
  anything else seen across all four harnesses (first-class column vs.
  inferred/undocumented field) — worth reusing this as the canonical worker
  label wherever a harness's schema is this rich.
- The Codex `custom_tool_call`/`custom_tool_call_output` (`name:"exec"`)
  family must be explicitly excluded from `tool_start`/`tool_end`/
  `memory_write` detection logic — it is a generic code-exec sandbox, not an
  MCP call, and its `input`/`output` free text could otherwise false-positive
  match on strings like `mem_save` when a user's own script queries available
  tools (as happened in the one sampled Codex session).
