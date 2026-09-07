# Proposal: Office Agent Visualizer

## Intent

Four harnesses on this machine (Claude Code, Codex, OpenCode, Antigravity) each write rich session
telemetry to disk, but nothing makes that work *visible*, and every prior visualizer is
Claude-Code-only and hook-based. Build a passive, read-only "office" visualizer that renders live
agent activity across all four, launches sessions without injecting anything, and animates Engram
`mem_save` as a worker carrying a document to a dedicated archive location.

Now, because all detection rules are verified on-disk (`research-local-evidence.md`); deferring
costs full re-verification.

## Scope

### In Scope

- Four read-only ingestion adapters emitting one normalized event stream.
- Event model = prior art's eight types (`session_start`, `tool_start`, `tool_end`, `message`,
  `stats`, `status`, `parent`, `session_end`) plus `memory_write`, `launch_requested`,
  `launch_started`.
- Four distinct `memory_write` detectors behind one interface (no shared pattern match).
- Zero-injection launcher (Claude Code, Codex, OpenCode, `agy`), strictly separate from ingestion.
- Animated 2D office scene: per-agent workers, parent/child lanes, archive destination.
- Node/TypeScript; `node-pty`, `chokidar`, PixiJS v8 or Canvas 2D, local HTTP server + browser tab.
  Not Electron.

### Out of Scope

- Any write to a harness config, hook file, database, or transcript.
- Launching the Antigravity IDE (CLI `agy` only).
- Historical/analytics dashboards, remote or multi-machine use, packaging/distribution.

## Capabilities

### New Capabilities

- `harness-log-ingestion`: locate, tail and parse the four harness session stores.
- `normalized-event-model`: harness-agnostic event schema and stream contract.
- `memory-write-visualization`: per-harness Engram `mem_save` detection → archive animation.
- `agent-launcher`: zero-injection PTY/process spawn and its self-originated events.
- `office-scene-renderer`: 2D scene, worker mapping, single- and multi-agent layout.

### Modified Capabilities

None — greenfield workspace.

## Approach

| Layer | Decision |
|---|---|
| Ingestion | Adapter per harness behind one interface. JSONL tailing via `chokidar` for Claude Code, Codex, Antigravity; strictly read-only SQLite for OpenCode, polled incrementally on `event.seq`. |
| `memory_write` | Four detectors: Claude `tool_use.name` ~ `mcp__*engram*__mem_save`; Codex `event_msg`/`item_completed` → `payload.item.type == "McpToolCall"`; OpenCode `part.tool == "engram_mem_save"`; Antigravity `call_mcp_tool` + de-quoted `args.ServerName`/`args.ToolName` (double-encoded, second parse required). |
| Launch | Hard invariant: **zero injection**. No `--append-system-prompt`, no custom `--settings`, no config mutation. Spawn the harness plainly; the user's own configuration stands. Launch events originate from our process and never from a harness log. |
| Separation | Ingestion is read-only and passive; launching is active. Two subsystems, one shared event bus, no shared code path. |
| Worker labels | Prefer first-class fields: OpenCode `session.agent`, Antigravity `toolAction`/`toolSummary`. Claude `attributionAgent` is best-effort with fallback. |

### Corrections to `comparativa-harnesses-agentes.md`

The source doc's rationale is partly wrong; the conclusion still holds.

| Doc claim | Reality | Effect |
|---|---|---|
| Hooks are Claude-Code-exclusive; Codex/Antigravity/OpenCode cannot support hook visualizers | **False for Codex.** `~/.codex/hooks.json` exists and is in active use (`SessionStart` → `gentle-ai skill-registry refresh`); Codex `docs/config.md` documents `SessionStart` and `PreToolUse` | None on the decision |
| Antigravity has "zero native support" | Refers to existing *tooling*, not log availability. Antigravity emits parseable, tool-call-annotated transcripts and documents a sub-agent primitive (`/agents` panel, states `running`/`done`/`error`/`killed`; agents are Markdown + YAML frontmatter under `.agents/agents/<name>/agent.md`) | Antigravity gets full parity |

Category (B) remains correct for the corrected reason: merged hooks do not collide at runtime — the
real hazard is an **installer rewriting shared config files** — and OpenCode plus the Antigravity IDE
still expose no hook surface at all.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/ingest/adapters/{claude,codex,opencode,antigravity}.ts` | New | Read-only source adapters |
| `src/ingest/detectors/memory-write/*.ts` | New | Four `mem_save` detectors |
| `src/events/` | New | Normalized event model + bus |
| `src/launch/` | New | Zero-injection spawner |
| `src/scene/` | New | PixiJS/Canvas office renderer |
| `src/server/` | New | Local HTTP + stream to browser |
| `package.json`, `tsconfig.json` | New | Toolchain; unblocks `strict_tdd` in `openspec/config.yaml` |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `node-pty` unreliable on target platform: latest is `v1.2.0-beta.15` (Aug 2024), beta 2+ years; 2026 macOS arm64 reports of segfaults, missing spawn-helper execute permission, x64/arm64 mismatch | High | Default non-interactive launches to plain `child_process` (`--print`-style, no PTY). Reserve PTY strictly for interactive sessions, behind a capability probe with graceful degradation. Keep the PTY dependency swappable. |
| `opencode.db` schema is an undocumented internal detail with automatic migrations | High | Version-tolerant adapter: probe tables/columns at startup, degrade to a disabled-with-reason state on drift, never crash the visualizer. |
| Direct SQLite reads diverge from prior art — `percheniy/office-for-claude-agents` refuses to read `opencode.db`, citing corruption risk | Medium | Justified divergence: since OpenCode v1.2 no file-based session log exists, so the prior art's fallback is gone. Open `file:...?mode=ro&immutable=0` read-only, never write, never checkpoint, never delete `-wal`/`-shm`; poll on `event.seq`; treat `SQLITE_BUSY` as backoff, not error. Document the WAL-contention argument in design. |
| Antigravity IDE sessions are unlaunchable and use a separate storage root that "does not join" the CLI | Medium | Read IDE transcripts where possible; scope launch to `agy` only; surface IDE sessions as read-only. |
| `attributionAgent` is undocumented and may change across Claude Code versions | Medium | Treat as a display hint with a deterministic fallback label; never load-bearing for correlation (use `toolUseResult.agentId`). |
| Requirement #2 (passive) vs #3 (launch) tension | Medium | Strict subsystem separation; launch emits only `launch_requested`/`launch_started` from our own process. |
| Contract collision with gentle-ai/Engram orchestrator contracts | Medium | Zero-injection is a hard architectural invariant, enforced in design and tests. |
| Stale config misread: `~/.gemini/antigravity-cli/mcp_config.json` is unused | Low | Read `~/.gemini/config/mcp_config.json` or workspace `.agents/mcp_config.json` only. |

## Rollback Plan

Nothing on the host is mutated: ingestion is read-only, launch is zero-injection, no harness config
or database is written. Rollback = stop the process and delete the workspace source tree. No harness
state, transcript, or config requires repair. Per-adapter rollback: disable one adapter via config;
the other three continue.

## Dependencies

- Node.js + TypeScript toolchain (not yet present; greenfield).
- `node-pty` (risk-flagged above), `chokidar`, `better-sqlite3`-class read-only driver, PixiJS v8.
- Harness CLIs present on `PATH` for launch: `claude`, `codex`, `opencode`, `agy`.

## Success Criteria

- [ ] All four adapters emit normalized events from real on-disk sessions with no writes to any harness path.
- [ ] `memory_write` fires correctly for a real `mem_save` on each of the four harnesses.
- [ ] The office scene animates a worker to the archive destination on every `memory_write`.
- [ ] Sessions launch from the scene with a byte-identical command line to a manual launch (zero injection).
- [ ] Parent/child agents render in distinct lanes for Claude Code and OpenCode.
- [ ] OpenCode adapter survives a simulated schema drift by degrading, not crashing.

## Delivery Note

This change clearly exceeds the 400-line review budget. `400-line budget risk: High`. Recommend
chained slices for `sdd-tasks`: (1) event model + Claude Code adapter + minimal scene, (2) Codex +
Antigravity adapters, (3) OpenCode SQLite adapter, (4) launcher, (5) memory-write animation polish.
`ask-on-risk` applies — the orchestrator should confirm slicing before apply.
