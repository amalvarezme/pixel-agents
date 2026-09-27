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

- [x] Serve the built UI from the Node server: a static branch in `createStreamServer` (or beside it)
      so `dist/` is served from the same origin as `/stream`, with a sane `index.html` fallback and
      correct content types. Keep `/stream` and `/launch` untouched.
      → `createStreamServer(hub, launcher?, { staticRoot })` (`adapters/driving/http/stream.ts`).
      Zero new dependencies (`node:fs/promises` + `node:path` only). `staticRoot` is injectable, so
      tests point at a temp dir instead of requiring a build. `src/server.ts` passes
      `join(process.cwd(), 'dist')`. A missing root degrades to the previous 404-for-unknown-paths
      behaviour instead of crashing. `/stream` and `/launch` are matched FIRST; every `/launch`
      shape that was a 404 before is still a 404 (it never falls into the SPA fallback).
- [x] A single command that lifts everything: `npm run office` (build if needed, then start the one
      process), replacing the need for two terminals.
      → `"office": "vite build && vite-node src/server.ts"`. The build is unconditional (a stale
      `dist/` can then never be served); `dev`, `dev:server` and `dev:client` are unchanged.
- [x] Prove it end to end: build, start the ONE process, load the page, and confirm the floor renders
      and the SSE stream connects **through the same origin**, with `/launch` still reachable.
      → `npm run office` on `PORT=4399`: `GET /` 200 `text/html`; `GET /assets/index-CX747f3W.js`
      200 `text/javascript` (347876 B); `GET /characters/scorpion/scorpion_portrait_v3.png` 200
      `image/png`; `GET /characters/characters_manifest.json` 200 `application/json`;
      `GET /office/session/abc` 200 `text/html` (SPA fallback); `GET /assets/nope-1234.js` 404;
      `GET /stream` 200 `text/event-stream` with `event: snapshot`; `POST /launch` with an invalid
      body 400 (route reached, nothing spawned). "The floor renders" was NOT browser-verified — the
      HTTP surface and the built bundle were, and nothing about the bundle had to change.
- [x] Honest limits: `dist/` must be built first, and the checkpoint file still resolves from the
      process's working directory.
      → Unchanged and still true. New: the static root also resolves from `process.cwd()`.

### Slice 1 decisions the design did not make

- **Missing-path policy.** (1) The exact file wins (`/` → `index.html`). (2) A missing path WITH a
  file extension 404s — handing HTML to a `<script src>` would surface as a MIME error, not a
  missing-asset error. (3) A missing path with NO extension falls back to `index.html` so a
  client-side route still loads. (4) A traversal attempt 404s and NEVER falls back, so the fallback
  cannot absorb it into a 200.
- **Traversal guard (the one security requirement).** Node's HTTP layer hands the handler the RAW
  request-target (`GET /..%2fpackage.json` arrives verbatim; `new URL(...).pathname` collapses a
  literal `../` but leaves `%2f`). The handler decodes the path and then re-checks that the RESOLVED
  ABSOLUTE path is still inside the root. Pinned by a raw-socket test (which bypasses `fetch()`'s
  client-side normalisation) plus a mutation check: removing the guard serves
  `<root>/../package.json` and the test goes red.
- **Fallback for unknown/dir paths without an extension** returns the root's `index.html` even if the
  request was a directory (e.g. `/assets/`), which is the standard SPA behaviour and leaks nothing.

## Slice 2 — the MCP server

- [x] `src/mcp/` with a stdio entry, plus a `bin` in `package.json`.
      → `src/mcp/stdio.ts` speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (`initialize`,
      `notifications/initialized`, `ping`, `tools/list`, `tools/call`). `package.json` gains
      `"bin": { "office-mcp": "./src/mcp/stdio.ts" }` and an `npm run mcp` script. There is no
      build step and no compiled `bin`: the source is TypeScript and the project already runs its
      own TS runtime (`vite-node`), so a client starts it with
      `node node_modules/vite-node/vite-node.mjs src/mcp/stdio.ts` (see the config block below).
- [x] An idempotent lifecycle manager over the visualizer: probe the port BEFORE spawning, because
      the server has no `EADDRINUSE` handling and a second start would crash; pass a free `PORT` to
      the child and read it back rather than assuming 4317.
      → `src/mcp/office-controller.ts`: `probe(port)` returns `free` / `ours` / `foreign`; `free`
      spawns on the default port, `ours` returns the already-running office unchanged, `foreign`
      picks a free port (`findFreePort`) and passes it to the child. `office_start` waits for the
      port to answer before returning, and kills the child it spawned if readiness times out.
- [x] **stdout is the MCP protocol**: the visualizer's own startup `console.log` must go to a file or
      a pipe, never to the MCP stream.
      → `src/mcp/visualizer-spawner.ts` opens `.data/office-mcp-visualizer.log` (override with
      `OFFICE_MCP_LOG`) and gives the child `stdio: ['ignore', logFd, logFd]`. The parent's own
      diagnostics go to `process.stderr`. Pinned by the end-to-end test: every raw stdout line is
      JSON, the banner is absent from it, and the banner IS present in the log file.
- [x] Tool surface, split by whether it mutates (which maps onto `approveTools`):
      `office_start` (idempotent, returns the URL), `office_stop`, `office_launch` (proxies to
      `POST /launch` so the existing Zero-Injection denylist applies for free) — and read-only
      `office_status` and `office_snapshot`, the latter returning the hub's existing snapshot JSON.
      → `src/mcp/tools.ts` declares all five and the JSON-RPC layer reads that catalog for
      `tools/list`. `office_launch` forwards its arguments verbatim to `POST /launch`
      (`src/mcp/office-client.ts`) so the validation is never duplicated; `office_snapshot` reads
      the first `event: snapshot` frame from the live `/stream` with a timeout and closes.
- [x] A `lifecycle: lazy` config block for `~/.pi/agent/mcp.json` in the shape the existing entries
      use. See "The `~/.pi/agent/mcp.json` entry" below.
- [x] Honest limits to state with it. See "Honest limits" below.

### The `~/.pi/agent/mcp.json` entry

```json
"office": {
  "approveTools": ["*start*", "*stop*", "*launch*"],
  "args": ["node_modules/vite-node/vite-node.mjs", "src/mcp/stdio.ts"],
  "command": "node",
  "cwd": "/Users/andresalvarez/Documents/pixel-agents",
  "lifecycle": "lazy"
}
```

`approveTools` names the three MUTATING tools (`office_start`, `office_stop`, `office_launch`); the
read-only `office_status` and `office_snapshot` are deliberately absent. The existing entries use
glob-shaped patterns (`*click*`), so the glob form above is the wildcard-equivalent.

**Why `node node_modules/vite-node/vite-node.mjs src/mcp/stdio.ts`.** The project is TypeScript with
no compiled `bin` and no build step for the server. `vite-node` is already the project's TS runtime
(`npm run office` uses it), so this reuses the pinned local copy with zero new dependencies and no
PATH assumptions. `cwd` is the project root because the visualizer child, the checkpoint file and
`dist/` all resolve from the serving process's working directory. A client could instead run the
`bin` (`office-mcp`) or `npx --no-install vite-node src/mcp/stdio.ts`; the explicit `node ...` form
is the one that cannot silently fall back to a network install.

### Honest limits

- **A stdio MCP dies with its client.** The child is deliberately NOT detached, so closing the chat
  session stops the office — the port is never left occupied. `office_status` says which case it is
  in (`running (this MCP server started it; office_stop will stop it)` vs `running but NOT started by
  this MCP server; office_stop will not stop it`), and `office_stop` only ever signals a process this
  server spawned.
- **SSE is a push channel; a tool call is request/response.** The mapping is URL + text snapshot: the
  BROWSER holds the `/stream` connection and renders the floor; `office_snapshot` returns one frame of
  state as text. No progress notifications or subscriptions are implemented.
- **`POST /launch` is unauthenticated on localhost** by the visualizer's own documentation; proxying
  preserves that posture and its Zero-Injection denylist, and adds no new authority.
- **No harness logs at all is a legitimate empty floor.** `office_status` reports `sessionCount: 0`
  (not an error) whenever the office is up; `sessionCount: null` only when the office is down, because
  then the count is genuinely unknowable.
- **What the protocol does not implement.** Resources, prompts, sampling, logging and progress
  notifications are absent by design (the maintainer chose the hand-rolled protocol); a client that
  requires any of them will not find it here.

## Not verified by the exploration

Whether `vite build` output works unmodified behind a static handler — **VERIFIED in slice 1**: the
build ran, the single process served `dist/` (html/js/png/json) and the SSE stream on one origin,
and no change to the bundle was needed. Pi's canonical MCP config schema beyond the keys observed in
the existing entries remains unverified (slice 2).
