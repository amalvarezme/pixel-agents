# Tasks: make the office MCP installable from the repository

Feature doc for ODD. Read-only audit first (`odd/tasks/office-mcp.md` documents the MCP itself);
this feature fixes what the audit found, so a third party cloning the public repo can actually
connect to the visualizer.

## Goal

`github.com/amalvarezme/pixel-agents` is PUBLIC. Someone cloning it must be able to install the
`office` MCP server in Pi and use it, without machine-specific editing.

## What the audit found (verified, with code evidence)

1. **The committed `.mcp.json` carries a machine-only absolute `cwd`**
   (`/Users/andresalvarez/Documents/pixel-agents`). The adapter VALIDATES a configured `cwd` and
   throws before connecting —
   `~/.pi/agent/npm/node_modules/pi-mcp-adapter/dist/server-manager.js:805-810`:
   `MCP server "office" configured cwd does not exist: "..."`.
   The `args` are relative (`node_modules/vite-node/vite-node.mjs`), so they depend on that `cwd`.
2. **A clone has no `dist/`** (gitignored) and `office_start` does NOT build:
   `src/mcp/visualizer-spawner.ts` spawns `vite-node src/server.ts` only — its own comment calls it
   "the same way `npm run office` does (its second half)". With no static root, `GET /` is a 404,
   pinned by `src/adapters/driving/http/stream.test.ts:410`.
3. **No install documentation.** `README.md` never mentions the MCP, `.mcp.json`, `npm run office`
   or the five tools; only `odd/tasks/office-mcp.md` documents them, and that is a work doc.
4. **No distribution channel**: `"private": true`, no `files`/`exports`, `bin.office-mcp` points at
   `./src/mcp/stdio.ts` (TypeScript, no build step). Clone + `npm install` is the only real path.
5. **Hidden coupling**: `vite-node` is NOT a direct dependency — it arrives through `vitest@2.1.9`
   (`npm ls vite-node`). The `.mcp.json` command, the `office`/`mcp` scripts and
   `createVisualizerSpawner`'s `join(projectRoot, 'node_modules', 'vite-node', 'vite-node.mjs')` all
   depend on it, so `npm install --omit=dev` breaks the MCP and the visualizer together.
6. **Non-obvious install step**: project-derived servers sit behind a trust gate —
   `pi-mcp-adapter/project-server-trust.ts:223 applyProjectServerTrustToConfig` (via
   `ctx.isProjectTrusted`). Without trust the server stays blocked with no clear explanation.

## Decisions taken with the maintainer BEFORE any edit

- **Make it installable**, scoped to three work units (cwd + dependency + README). Publishing to npm
  is explicitly NOT in scope: `private: true` stays.
- **`office_start` does NOT gain a build step in this feature.** Running `vite build` inside a tool
  call is a behaviour change with its own failure modes (build time, failures, concurrent starts)
  and deserves its own authorization. The prerequisite is documented instead, and recorded here as
  an open follow-up.
- **The portable form is "omit `cwd`".** `defaultCwd` is the session cwd
  (`pi-mcp-adapter/init.ts:152 new McpServerManager(cwd)`) and the existence validation is skipped
  when `cwd` is undefined (`if (cwd !== undefined)`). The only interpolation available for a
  configured `cwd` is `${VAR}`/`$env:VAR`/`{env:VAR}` (`resolveConfigPath` = expandHome +
  `interpolateEnvVars`); there is no `${workspaceFolder}`, and requiring an exported env var is
  worse friction than requiring the project root.
- **Removing `cwd` alone would trade a hard failure for a conditional one**, because
  `createOfficeMcp` defaults `projectRoot` to `process.cwd()`. So the default must be derived from
  the module's own location instead, which makes the server correct from any session cwd. This is a
  change of the DEFAULT only; the `projectRoot` option keeps overriding it, which is what the tests
  and the composition root use.

## Tasks

- [x] **T1 — the server finds its own root.** (commit `4785c0a`)
      The `cwd` line is gone from `.mcp.json` and `resolveProjectRoot()` derives the root from
      `new URL('../..', import.meta.url)`, with `options.projectRoot` still winning.
      Evidence: new test `src/mcp/office-mcp.test.ts` (4 tests) — RED first
      (`TypeError: resolveProjectRoot is not a function`), then GREEN 4/4. MUTATION, reproduced by
      the parent independently: with the helper reverted to `process.cwd()`, exactly the two
      cwd-independence assertions go red, and the file was restored byte-identically
      (sha256 `c37b7292…3695`). Proven under the REAL runtime too, not just vitest: a throwaway
      script run through `vite-node` **from a subdirectory** printed
      `root: /Users/andresalvarez/Documents/pixel-agents/` with a different `process.cwd()`.
      `.mcp.json` now contains zero absolute paths and its `command`/`args`/`lifecycle`/
      `approveTools` are byte-identical to the previous revision.

- [x] **T2 — `vite-node` is declared, not inherited from vitest.** (commit `09c2532`)
      Added as `"vite-node": "2.1.9"` under `dependencies` (exact, matching the version vitest
      installs) and the lockfile was refreshed by npm. Evidence: `npm ls vite-node` resolves exactly
      ONE copy (`vite-node@2.1.9` plus `vitest@2.1.9 -> vite-node@2.1.9 deduped`, no warning); no
      package version changed. Deliberate consequence: vite and its esbuild binary lose their
      lockfile `dev` markers, so a production install now pulls them — a TypeScript runtime that
      must start in production is the reason. A fresh `npm install --omit=dev` was NOT executed
      (it would mutate `node_modules`); the dependency-type claim rests on the lockfile metadata
      plus `npm ls --omit=dev`, and T4 exercises the real install instead.

- [x] **T3 — the README teaches the install.** (commit `aaaca03`)
      New `## Driving the office from an MCP client`: the five tools split by mutation, the
      committed entry verbatim, and the four setup steps (clone + `npm install`; a one-time
      `npm run build`; open the client in the repository root; trust the project). Ends with what
      the server does NOT do. Every factual sentence was checked against the source, not assumed:
      `/stream` and `/launch` are matched before the static branch (`stream.ts:326,330,338`), so a
      missing `dist/` costs the page and not the stream; `stop()` only ever touches `this.managed`;
      `office_launch`'s own description says nothing is spawned by the MCP server; the protocol
      dispatcher implements `initialize`, `ping`, `tools/list`, `tools/call` and nothing else; the
      log path is `env.OFFICE_MCP_LOG ?? visualizerLogPath(projectRoot)` under the module-derived
      root; and approval really is keyed by `hashProjectServerDefinition` (sha256 of the
      canonicalized definition), so editing the entry asks again.

- [x] **T4 — acceptance on a real clone.** (this document's commit)
      A true `git clone` of this repository into `~/Documents/pixel-agents-clone-audit` — outside
      this working tree, so no untracked file travelled — then `npm install` and `npm run build`.
      Driving the COMMITTED entry's command from the clone root returned `initialize` OK, the five
      tools, `office_status` reporting down and then `running (this MCP server started it…)`,
      `office_start` on `http://127.0.0.1:4317` (21 sessions seen), `GET /` **200 text/html** whose
      body is exactly the clone's `dist/index.html` (3680 characters / 3682 bytes — the driver's
      counter was characters, and the file carries one em dash), `GET /stream` **200
      text/event-stream** with an `event: snapshot` frame, and `office_stop` reporting `stopped:
      true`. The port was verified free afterwards (no leftover process).
      One false alarm worth recording: the driver first failed on an assertion of mine for
      `id="root"`; the real mount is `<div id="office">`. The assertion was wrong, not the code.

## Deliberately open after this feature

- `office_start` does not build a missing `dist/` (documented prerequisite, see Decisions).
- No npm distribution: clone + `npm install` remains the only path.
- Opening Pi in a SUBDIRECTORY of the clone: the project config is still discovered (ancestor
  discovery), but the entry's relative `args` resolve against the session cwd, so the server can
  fail to launch. Documented in the README as the project-root requirement.
