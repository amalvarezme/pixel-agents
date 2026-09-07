# Office Agent Visualizer

Renders your own coding-agent sessions as workers in a small pixel-art office. It watches your
agent harness's session logs on disk — read-only — and streams a live, normalized view of what
each session is doing to a browser tab.

## What works today

- **Claude Code only.** Sessions under `~/.claude/projects/` (default) show up as workers as soon
  as this app discovers their log file; tool calls animate a `working`/label update on the desk.
- A **real SSE stream** (`GET /stream`) with resume-on-reconnect (`Last-Event-ID`, ring buffer,
  snapshot-on-desync) and a **real PixiJS scene** in the browser, wired end to end.
- Everything is **read-only** against your harness data. The only thing this project writes is its
  own checkpoint file, under `.data/` in this repo — never anything under `~/.claude/`.

## What is NOT built yet

- Other harnesses: **Codex, Antigravity, OpenCode** adapters (slices 2–3 of the design).
- The `memory_write` archive-carry **animation** (slice 4) — memory saves are not yet detected as
  a distinct animated event in this composition; the underlying per-harness detectors exist and
  are tested, but nothing wires them into the live event stream yet.
- The **launcher** (slice 5) — you cannot start a new agent session from the UI yet.
- **Parent/child lanes for real Claude Code subagents.** The correlation logic
  (`adapters/driven/claude-code/correlate.ts`) and the lane-rendering logic
  (`OfficeContainer`/`office-layout.ts`) are both implemented and tested independently, but nothing
  yet bridges a real subagent's correlation into a `parent` event on the live stream — so today,
  real subagents render as flat, unrelated workers rather than in a distinct child lane.
- **Session end / idle-out.** A session that stops writing stays on the floor; the idle/evict
  timers (`domain/sessions/session-lifecycle.ts`) exist but are not wired into this composition.

## Quick path

```sh
npm install
npm run dev
```

Then open the URL Vite prints (typically `http://127.0.0.1:5173`). That command starts two
processes: the Node backend (`src/server.ts`, reads `~/.claude/projects/`, serves SSE on
`127.0.0.1:4317`) and the Vite dev server (serves the page, proxies `/stream` to the backend).

Both bind to `127.0.0.1` only — this stream carries the content of your private agent sessions and
is never exposed on the network.

To point it at a different tree (a fixture, for example) instead of your real `~/.claude`:

```sh
CLAUDE_HOME=/path/to/fixture-root npm run dev
```

(`CLAUDE_HOME` is the harness root — the directory that CONTAINS `projects/`, matching `~/.claude`
itself, not `~/.claude/projects`.)

## Verifying the scene renders

`PixiOfficeRenderer.mount` is the one piece no automated test can cover: it needs a real browser
with a real canvas. Verify it by hand.

1. `CLAUDE_HOME=/path/to/fixture-root npm run dev`, then open the page.
2. Every session file already under `<fixture-root>/projects/` should appear as a desk, and the
   row of desks should sit CENTRED in the window at any window size — the floor plan is a fixed
   1920x1080 scene space contain-fitted to the viewport (`fitToViewport`), so resizing the window
   rescales the whole floor instead of clipping it.
3. Append a line to a new `.jsonl` under `<fixture-root>/projects/<slug>/` while the page is open.
   A new desk should appear within a second or two, with no reload.

## Architecture

Hexagonal: `domain/` (framework-free) <- `application/` (use cases) <- `ports/` (interfaces) <-
`adapters/` (concrete I/O) <- `ui/` (container/presentational + PixiJS). See
`openspec/changes/office-agent-visualizer/design.md` for the full design and
`src/server.ts`/`src/ui/main.ts` for the two composition roots (server-side and browser-side).

## Testing

```sh
npm test         # vitest run
npm run typecheck # tsc --noEmit
npm run lint:deps # dependency-cruiser boundary rules
```

Strict TDD throughout. The `EventSource` reconnect/backoff/resume logic and the SSE server are
unit- and integration-tested against fakes; mounting a real PixiJS canvas and loading the page in
an actual browser are the two things only a manual run can verify (see `tasks.md`'s
`browser-entrypoint` section for exactly what is and is not automated).
