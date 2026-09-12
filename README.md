# Office Agent Visualizer

Renders your own coding-agent sessions as workers in a small pixel-art office. It watches each
harness's session logs on disk — read-only — and streams a live, normalized view of what every
session is doing to a browser tab.

## What works today

- **All four harnesses**, each behind the same `ActivitySource` port:
  | Harness | Source | Root (override) |
  |---|---|---|
  | Claude Code | `*.jsonl` transcripts | `~/.claude` (`CLAUDE_HOME`) |
  | Codex | date-partitioned `rollout-*.jsonl` | `~/.codex` (`CODEX_HOME`) |
  | Antigravity | CLI + IDE `transcript.jsonl` | `~/.gemini` (`GEMINI_HOME`) |
  | OpenCode | read-only SQLite polling | `~/.local/share/opencode/opencode.db` (`OPENCODE_DB_PATH`) |

  Each is independently disableable with `<HARNESS>_ENABLED=false` — `CLAUDE_CODE_ENABLED`,
  `CODEX_ENABLED`, `ANTIGRAVITY_ENABLED`, `OPENCODE_ENABLED`. A harness whose root is absent on
  this machine degrades quietly instead of stopping the server.

- **`memory_write` detection and the archive animation.** When a session calls Engram's `mem_save`,
  its worker carries a document to the archive, the counter increments, and the worker returns.
  Several saves at once collapse into one batched `×N` carry. Detection is per-harness because the
  four encode MCP tool calls in four incompatible shapes — Antigravity's, for instance, double-JSON-
  encodes its `ServerName`/`ToolName`, so a naive comparison against `engram` is always false.

- **A real SSE stream** (`GET /stream`) with resume-on-reconnect: `Last-Event-ID`, a ring buffer,
  and a snapshot frame that carries the full office state — workers, archive slots and in-flight
  carries — so a client connecting late reconstructs what it missed rather than starting at zero.

- **A launcher** (`POST /launch`, plus a control in the UI) that starts a harness CLI with argv
  **byte-identical** to what you would have typed. It never injects a system prompt, settings or
  config file, `shell: false` is hard-coded rather than a caller option, and spawned children are
  tracked and terminated on shutdown. A launch is correlated back to the session it produces.

- Everything is **read-only** against your harness data. The only thing this project writes is its
  own checkpoint file under `.data/` in this repo — never anything under a watched root, and never
  a write, checkpoint or `journal_mode` change against OpenCode's live database.

## What is NOT built yet

- **Parent/child lanes for real Claude Code subagents.** OpenCode's parent/child correlation works
  end to end — it has a first-class `session.parent_id` column and emits `parent` events. Claude
  Code's equivalent (`adapters/driven/claude-code/correlate.ts`) and the lane rendering are both
  implemented and tested independently, but nothing bridges a real subagent's correlation into a
  `parent` event on the live stream, so Claude Code subagents render as flat, unrelated workers.
- **Session end / idle-out.** A session that stops writing stays on the floor; the idle/evict
  timers in `domain/sessions/session-lifecycle.ts` exist and are tested but are not wired into this
  composition.
- **Interactive PTY sessions.** `node-pty` is deliberately not a dependency, so the capability
  probe always reports unavailable and an interactive launch surfaces a copyable command line
  instead of silently degrading to a non-TTY process.

## Quick path

```sh
npm install
npm run dev
```

Then open the URL Vite prints (typically `http://127.0.0.1:5173`). That starts two processes: the
Node backend (`src/server.ts`, serving SSE on `127.0.0.1:4317`) and the Vite dev server, which
proxies `/stream` to it.

Both bind to `127.0.0.1` only — this stream carries the content of your private agent sessions and
is never exposed on the network. For the same reason `POST /launch` refuses injection-flagged
arguments (`--append-system-prompt`, `--system-prompt`, `--settings`, `--config`): it is an
unauthenticated local endpoint, so arriving in an HTTP body is not evidence that you typed it.

To point a harness at a fixture tree instead of your real one:

```sh
CLAUDE_HOME=/path/to/fixture-root CODEX_ENABLED=false ANTIGRAVITY_ENABLED=false OPENCODE_ENABLED=false npm run dev
```

Each `<HARNESS>_HOME` is the harness ROOT — the directory that *contains* `projects/`, matching
`~/.claude` itself, not `~/.claude/projects`.

### Bootstrap: active window and replay

On startup, each of the three JSONL harnesses (Claude Code, Codex, Antigravity) only attaches to
sessions whose file was touched in the last 24h — a real `~/.claude` can carry hundreds of stale
transcripts, and discovering all of them would flood the scene with sessions that are not actually
running. A session with no prior checkpoint then bootstraps **at EOF**: it starts empty and only
renders content appended from that point on, never the transcript's pre-existing history — the
same flood risk applies to reading a single large file from the start.

For a fixture tree, this means a freshly written session file (or a `cp -r` that preserves recent
mtimes) is still discovered — the desk appears — but its EXISTING content is not replayed as
worker activity. To see a fixture's full pre-existing history rendered (not just newly appended
lines), set `REPLAY_FROM_START=true`:

```sh
REPLAY_FROM_START=true CLAUDE_HOME=/path/to/fixture-root CODEX_ENABLED=false ANTIGRAVITY_ENABLED=false OPENCODE_ENABLED=false npm run dev
```

This is the opt-in the design calls out for demos and fixture capture; it is OFF by default so a
real `~/.claude` never replays 173k historical lines on every server start.

## Verifying it by hand

Mounting a real PixiJS canvas is the one thing no automated test covers; it needs a real browser.

1. Start against a fixture root as above (add `REPLAY_FROM_START=true` if the fixture already has
   content you want rendered) and open the page. Every session already on disk should appear at one
   of the room's eleven workstations, head and torso above the desk and legs behind it, and the
   whole room should stay centred at any window size — it is a fixed 1672×941 space contain-fitted
   to the viewport, so resizing rescales it instead of clipping.
2. Append a line to a new `.jsonl` under `<fixture-root>/projects/<slug>/` while the page is open.
   A new agent should appear at the next free workstation within a second or two, with no reload.
3. Append a `tool_use` record naming `mcp__engram__mem_save`. That worker should walk — around the
   furniture, never through it — to the Persistent Memory Archive, point at it, and walk back,
   and the counter should increment. Append several at once and the carry should collapse into one
   `×N` batch.
4. Stop the page, let a few saves be ingested, then reload. The counter should come back non-zero —
   that is the snapshot carrying archive state, not a replay.

## The office

The room is the **Pixel Office v2** environment (`public/office/`, a 1672×941 illustration). It is
not drawn by us: `background.png` is the room, `foreground.png` is the furniture that stands in
front of its occupants, and `src/ui/scene/world/office-map.json` — a verbatim copy of the pack's
own map — is the single source of truth for what is where.

- **Eleven workstations.** `office-map.json` names them `ws_01`..`ws_11` with the anchor a
  character stands on to use each one. Agents are seated in that order; anyone past the eleventh is
  counted as overflow and listed by name in the roster panel instead.
- **Layer order** (guide section 4): background → agents the furniture stands in front of →
  foreground → agents it does not → UI, each group sorted by the y of their feet. The split is what
  makes an agent SIT AT its workstation instead of behind it: a workstation's anchor is the floor
  in front of the desk, so its occupant is drawn on top of that desk's art, facing the laptop.
  `world/foreground-occlusion.ts` decides which side each character is on, from the map's own
  collision rectangles — furniture only occludes a character when it overlaps the column its feet
  are in, overlaps the rows its body is drawn across, and has its own front edge nearer the viewer
  than those feet.
- **Perspective** comes from the map's own `depth.scaleBands`, plus one whole readability step and
  one more for an orchestrator. Whole numbers only — a fractional scale destroys pixel-perfect
  rendering.
- **Walking is routed, not interpolated.** `office-navigation.ts` is a typed port of the pack's own
  A*, run over the map's walkable bounds minus its collision rectangles, so an agent carrying a
  memory write to the Persistent Memory Archive goes around the desks instead of through them.
- **The Sentinel** patrols outside, drawn only through `window_mask.png` so it can never appear to
  be in the room. It is scenery: it represents no session, no agent and no event. Nothing else on
  the floor is decorative, which is exactly why this one thing has to say so.
- One anchor in the shipped map needed tuning; the reason is recorded in the map's own
  `localAdjustments` field, which is the only place the guide allows that kind of fix.

## Characters

Agents are drawn with the **Pixel Office v2** sprite pack (`public/characters/`, four 32x32
characters on 4x16 directional sheets; the pack's own docs are kept verbatim under
`docs/pixel-office/`).

- **Who** a worker is comes from its project: `resolveCharacterId` hashes `projectPath` into the
  four characters, so an orchestrator and every subagent under one project are the same person.
- **Role** is size only: `resolveCharacterScale` draws an orchestrator one whole step larger than
  a subagent standing in the same place — never a ratio, because a fractional scale destroys
  pixel-perfect rendering.
- **State** picks the clip and the direction it is drawn in, all four from the map's own declared
  facings: `typing` facing the laptop (`up`) while working, `idle` turned toward the room (`down`)
  once the session goes quiet (dimmed), `walk` in whichever of the four directions it is actually
  heading, `point` at the Persistent Memory Archive on arrival. Timing comes from each character's
  own JSON, never from a table in our code.
- v2 sprites are **body-only**: desks, laptops and chairs belong to the scene, never to a
  character's frames. Every clip anchors the same way — the character's declared `origin` is the
  centre of its feet, and that point is what the scene positions.
- `left` is a runtime mirror of the `side` clip about that same origin, never a second set of art.
- If the pack fails to load, the scene falls back to the procedural figure in
  `ui/scene/character/character-pose.ts`. Nothing blocks on the textures.

## Architecture

Hexagonal: `domain/` (framework-free) ← `application/` (use cases) ← `ports/` (interfaces) ←
`adapters/` (concrete I/O) ← `ui/` (container/presentational + PixiJS). Boundaries are enforced by
`dependency-cruiser`, not convention: `domain/` cannot import an adapter, only `ui/scene/pixi/` may
import `pixi.js`, and the launcher subsystem has no import edge to any ingestion adapter.

`src/server.ts` and `src/ui/main.ts` are the two composition roots. The full design and the
delivered task history live in
`openspec/changes/archive/2026-09-08-office-agent-visualizer/`; the capability specs this change
merged are under `openspec/specs/`.

## Testing

```sh
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run lint:deps # dependency-cruiser boundary rules
```

Strict TDD throughout. Beyond keeping the suite green, guards here are checked by **breaking them
on purpose** and confirming the intended test fails — a habit that repeatedly caught tests passing
for the wrong reason, including a false-positive trap that was never exercising the guard it named
and a checkpoint that silently replayed a session's entire history.
