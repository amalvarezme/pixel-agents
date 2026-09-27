# Proposal: Pi Harness Portability

## Intent

Pi (the `gentle-pi` harness, "gentle shell") is a fifth coding agent running on this machine, and
it is the only one of the five that publishes a **first-class, contract-checked subagent registry**
to disk. Today pixel-agents cannot see a single Pi session: `HarnessId` is a closed union of four
ids, and the four existing `ActivitySource` implementations know nothing about Pi's layout.

Port pixel-agents to Pi as a fifth harness, and use Pi's registry to render subagent work the way
the other four harnesses cannot support: with **exact** parent/child linkage and with the real
lifecycle state of every subagent (`queued`, `waiting`, `running`, `failed`, …) drawn on the office
floor.

## Why Pi changes the shape of subagent monitoring

Verified on disk at `~/.pi/agent/` and against `gentle-pi/lib/` sources:

| Source | Location | Signal |
| --- | --- | --- |
| Orchestrator transcript | `~/.pi/agent/sessions/<encoded-cwd>/<iso-ts>_<uuid>.jsonl` | `session` record with `cwd`, `model_change`, `message` records with `toolCall`/`toolResult`, per-turn `usage` |
| Subagent presence header | `~/.pi/agent/gentle-agents/presence/<sessionHash>.<incarnation>.header.json` | `label`, `heartbeat` (5 s), `generation`, `counts{running,queued,waiting,finished}`, `digest` |
| Subagent presence activity | `~/.pi/agent/gentle-agents/presence/<sessionHash>.<incarnation>.activity.json` | per-task `{id, agent, label, status, model, createdAt, startedAt, endedAt, lastActivityAt}` plus a bounded `thread` of `text`/`thinking`/`tool{name,output,running,isError}` items |
| Subagent transcripts | `~/.pi/agent/gentle-agents/sessions/` | children are spawned with `--session-dir <that dir>` (`gentle-pi/lib/agents-runner.ts:283`) |
| Finished task history | `~/.pi/agent/gentle-agents/tasks/<task-id>.json` | full `TaskRecord` incl. `cwd`, `parentSessionId` |

Three consequences drive this change:

1. **Correlation is exact, not heuristic.** `header.sessionHash` is `sha256(parentSessionId)`.
   Hashing a discovered transcript's session UUID and looking it up yields the parent→child edge
   with certainty. Claude Code needs a ~350-line `subagent-correlation-coordinator.ts` to *guess*
   this; Pi needs a hash lookup. Pi therefore gets **no** correlation coordinator.
2. **Orchestrators and subagents never collide.** The two live under different roots
   (`~/.pi/agent/sessions/` vs `~/.pi/agent/gentle-agents/sessions/`), so `AgentRole` is decided by
   path structure, not by a content heuristic. This structurally prevents the duplicate-session
   defect class this project has already been burned by.
3. **Pi's status vocabulary exceeds our domain.** `SessionActivity` is `'working' | 'idle'`. Pi
   reports `queued`, `waiting`, `failed`, `cancelled`, `timed_out` as validated values. Mapping all
   of them onto `working` would throw away the most useful thing Pi knows. The domain gains a
   `SessionLifecycle` concept and the renderer learns to draw it.

## Scope

### In Scope

- `HarnessId` gains `'pi'`; every `Record<HarnessId, …>` site resolves its new member explicitly
  (4 sites, compiler-enforced).
- `PiActivitySource`: orchestrator transcripts discovered and byte-offset tailed, reusing the
  shared `readTailIncrement`/`watchAndTailFile` tailer, with `projectPath` from the `session`
  record's `cwd` and live `model` from `model_change`.
- `PiPresenceSource`: a bounded, digest-verified, read-only reader of the presence registry that
  emits `parent`, `session_start`, `tool_start`/`tool_end`, `status`, and `session_end` events for
  subagent tasks, keyed by `(sessionHash, incarnation, task.id)`.
- `SessionLifecycle` in the domain, carried on `status` events, projected into the office state and
  drawn by the renderer (a queued agent waits, a failed agent is flagged).
- `PiMemoryWriteDetector` for Engram `mem_save` tool calls in Pi's `toolCall` shape.
- Pi added as a launch target (`pi` binary) with an empty allowlisted template, preserving the
  Zero-Injection Spawn Invariant.
- Hover tooltip shows the Pi subagent's `agent` type, `label`, `model`, and lifecycle state.

### Out of Scope

- A click-to-inspect panel over presence `thread` items. The data is read and available, but no
  new interactive surface beyond the existing hover tooltip is built here. Deliberately deferred.
- Reading `~/.pi/agent/gentle-agents/sessions/` subagent transcripts. The presence registry already
  carries every field the office needs, at a fraction of the I/O.
- Reading `~/.pi/agent/gentle-agents/tasks/` finished-task history (replay of past runs).
- Writing anything under `~/.pi/`. Pi ingestion is read-only, like the other four.

## Risks and Rollback

| Risk | Mitigation |
| --- | --- |
| Presence registry layout is created lazily, so it can be absent | `probe()` reports `ready` regardless; a missing directory yields zero sessions, exactly like `OpenCodeActivitySource` with no DB. |
| Presence files are replaced atomically mid-read | Reads are bounded, `O_NOFOLLOW`, inode-pinned, and digest-verified against the header, mirroring `orchestrator-presence.ts`'s own reader. A digest or generation mismatch is a skip, never a throw. |
| `activity.json` can reach 16 MiB | Honour `header.unavailable === 'activity-too-large'` and `ACTIVITY_LIMIT`; an oversized registry degrades to header-only counts. |
| Adding `'pi'` to `HarnessId` breaks four exhaustive `Record` sites | That is the point: the compiler names every decision. No `default` branch is added anywhere. |
| New lifecycle states leak into the renderer as unhandled cases | `SessionLifecycle` is a closed union derived from a `const` array, same construction as `EVENT_KINDS`. |

Rollback is a single revert per work unit: each is independently green, and `PI_ENABLED=false`
disables Pi ingestion at the composition root without touching any other harness.

## Success Criteria

1. A live Pi session running in this repository appears on the office floor with its project name.
2. A Pi subagent launched via `subagent_run` appears as a child of that session, at the correct
   size and colour for its family, with its `agent` type and `label` in the tooltip.
3. A `queued` subagent is visually distinct from a `running` one, and a `failed` one from both.
4. `npm test`, `npm run typecheck`, and `npm run lint:deps` are clean after every work unit.
5. No file under `~/.pi/` is created, modified, or deleted by pixel-agents — proven by a
   `zero-write.test.ts` mirroring the four existing ones.
