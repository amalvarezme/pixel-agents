# Tasks: an MCP server for the office visualizer

Feature doc for ODD. Read-only design produced by an explorer; the maintainer chose to build it in
two slices.

## Goal

The maintainer wants the project connectable as an MCP server: an agent connects, and from that
connection **lifts the local server and sees the agents on the virtual office floor**.

## What the code actually allows (verified, with paths)

- **The server** (`src/server.ts`): binds `HOST = '127.0.0.1'` and `PORT ?? 4317`. Host is hardcoded
  loopback on purpose ("must never be reachable from another machine"). All configuration is env:
  `CLAUDE_HOME`, `CODEX_HOME`, `GEMINI_HOME`, `OPENCODE_DB_PATH`, `PI_HOME`, `REPLAY_FROM_START`, and
  one `*_ENABLED` kill switch per harness. Timers: launch correlation every 1s, session lifecycle
  every 30s, plus a 15s SSE heartbeat. Routes: `GET /stream` (SSE, ring-buffer resume via
  `Last-Event-ID`) and `POST /launch`. **Everything else is 404.** The only file it writes is
  `.data/checkpoints.json`, resolved from the CURRENT WORKING DIRECTORY. It runs until signalled.
- **The client**: dev runs TWO processes (`vite-node src/server.ts` and `vite` on 5173 with a proxy
  for `/stream` and `/launch`). `vite build` emits `dist/`, but **the Node server cannot serve it**:
  `createStreamServer` has no static-file branch.
- **The seam for events** is the pull/tail-shaped `ActivitySource` port, not a push subscription. For
  "see the agents" no new event plumbing is needed at all: the hub already maintains an in-memory
  `OfficeSnapshotState` projection, which IS the text form of the floor.
- **Layer rules allow a new `src/mcp/` adapter.** It may import `ports/`, `application/`, `domain/`
  and `shared/`. Because `server.ts` documents itself as the sole composition root, the cleanest
  shape is to EXTRACT factories from it rather than duplicate the wiring.
- **Dependency cost**: the project has only `chokidar` and `pixi.js` at runtime. The official MCP SDK
  would be the first new runtime dependency (pure TypeScript, plus a zod peer).

## One correction to the exploration report

The explorer stated that `~/.pi/agent/mcp.json` does not exist and that Pi's config file is
`mcp-adapter.json`. That was true at the moment it looked (the file had just been deleted) and is
FALSE now: `mcp.json` is the canonical config, and `mcp-adapter.json` is the harness's own copy which
does NOT carry `approveTools` or the Google `oauth` blocks. Two agents reading one filesystem at
different times is a real hazard; state the observation time with any filesystem claim.

## Slice 1 — one process, one command

- [ ] Serve the built UI from the Node server: a static branch in `createStreamServer` (or beside it)
      so `dist/` is served from the same origin as `/stream`, with a sane `index.html` fallback and
      correct content types. Keep `/stream` and `/launch` untouched.
- [ ] A single command that lifts everything: `npm run office` (build if needed, then start the one
      process), replacing the need for two terminals.
- [ ] Prove it end to end: build, start the ONE process, load the page, and confirm the floor renders
      and the SSE stream connects **through the same origin**, with `/launch` still reachable.
- [ ] Honest limits: `dist/` must be built first, and the checkpoint file still resolves from the
      process's working directory.

## Slice 2 — the MCP server

- [ ] `src/mcp/` with a stdio entry, plus a `bin` in `package.json`.
- [ ] An idempotent lifecycle manager over the visualizer: probe the port BEFORE spawning, because
      the server has no `EADDRINUSE` handling and a second start would crash; pass a free `PORT` to
      the child and read it back rather than assuming 4317.
- [ ] **stdout is the MCP protocol**: the visualizer's own startup `console.log` must go to a file or
      a pipe, never to the MCP stream.
- [ ] Tool surface, split by whether it mutates (which maps onto `approveTools`):
      `office_start` (idempotent, returns the URL), `office_stop`, `office_launch` (proxies to
      `POST /launch` so the existing Zero-Injection denylist applies for free) — and read-only
      `office_status` and `office_snapshot`, the latter returning the hub's existing snapshot JSON.
- [ ] A `lifecycle: lazy` config block for `~/.pi/agent/mcp.json` in the shape the existing entries
      use.
- [ ] Honest limits to state with it: a stdio MCP dies with its client, so "the office dies when the
      chat closes" unless the child is deliberately detached; SSE is a long-lived push channel and a
      tool call is request/response, so the mapping is URL + text snapshot, with the BROWSER holding
      the stream; the visualizer's launch endpoint is unauthenticated on localhost by its own
      documentation; and with no harness logs at all the floor is legitimately empty, which
      `office_status` must report as zero sessions rather than as a fault.

## Not verified by the exploration

Whether `vite build` output works unmodified behind a static handler (no build was run), and Pi's
canonical MCP config schema beyond the keys observed in the existing entries.
