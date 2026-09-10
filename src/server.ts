/**
 * Server composition root (browser-entrypoint work unit; extended by b1-remaining-harnesses). The
 * ONLY file that constructs and connects concrete adapters directly (design.md module structure:
 * everything else — `domain/`, `application/`, individual adapters — stays unaware of this
 * wiring):
 *
 *   `<Harness>ActivitySource` -> `ingestAgentActivity` -> `SseEventHub` -> `createStreamServer`
 *
 * Binds to `127.0.0.1` ONLY (never `0.0.0.0`): this stream carries the content of the user's
 * private agent sessions and must never be reachable from another machine on the network.
 *
 * Wires all four harnesses READ-ONLY through their own `ActivitySource` (tasks.md B.1, fully
 * closed by this work unit): Claude Code, Codex and Antigravity tail JSONL; OpenCode polls its
 * SQLite db (`opencode-activity-source` work unit) since it has no file-based session log since
 * v1.2. The only path this process ever writes to is its OWN checkpoint file under `.data/`
 * (`CHECKPOINT_FILE`, resolved from `process.cwd()`), entirely outside every watched tree —
 * including `OPENCODE_DB_PATH`'s directory — shared safely across harnesses because every
 * `sessionKey` this process ever mints is already prefixed with its harness id.
 *
 * Each source is independently disableable via `<HARNESS>_ENABLED=false` (tasks.md rollback
 * boundary: "disable each adapter independently via config"). A harness whose root/db does not
 * exist on this machine degrades quietly rather than crashing the process: `discoverCodexSessions`/
 * `discoverAntigravitySessions` already treat a missing root as "no sessions" (ENOENT -> `[]`),
 * and `OpenCodeActivitySource.discover()` yields nothing when `openOpenCodeDbReadOnly` reports
 * `disabled` (missing db, schema drift, or a missing `-shm` sidecar) — so ingestion for that
 * harness simply never finds anything to open.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActivitySource } from './ports/activity-source.port';
import { AntigravityActivitySource } from './adapters/driven/antigravity/activity-source';
import { ClaudeCodeActivitySource } from './adapters/driven/claude-code/activity-source';
import { scanAndApplyAgentProfiles } from './adapters/driven/claude-code/agent-profile-scan';
import type { ClaudeCodeSessionRef } from './adapters/driven/claude-code/discover';
import { ClaudeCodeSubagentCorrelationCoordinator } from './adapters/driven/claude-code/subagent-correlation-coordinator';
import { CodexActivitySource } from './adapters/driven/codex/activity-source';
import { OpenCodeActivitySource } from './adapters/driven/opencode/activity-source';
import { FileCheckpointStore } from './adapters/driven/checkpoint/file-checkpoint-store';
import { ChildProcessSessionLauncher } from './adapters/driven/launcher/child-process-session-launcher';
import { CorrelatingSessionLauncher } from './adapters/driven/launcher/correlating-session-launcher';
import { LaunchCorrelationCoordinator } from './adapters/driven/launcher/launch-correlation-coordinator';
import { SessionLifecycleCoordinator } from './adapters/driven/sessions/session-lifecycle-coordinator';
import { createNodePtyProbe } from './adapters/driven/terminal/node-pty-probe';
import { createStreamServer, SseEventHub } from './adapters/driving/http/stream';
import { ingestAgentActivity } from './application/ingest-agent-activity/ingest-agent-activity';
import type { EventPublisher } from './ports/event-publisher.port';

const PORT = Number(process.env.PORT ?? 4317);
const HOST = '127.0.0.1';
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? join(homedir(), '.claude');
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const GEMINI_HOME = process.env.GEMINI_HOME ?? join(homedir(), '.gemini');
const OPENCODE_DB_PATH = process.env.OPENCODE_DB_PATH ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
// design.md "Session discovery and aging out" — Bootstrap: "an opt-in --replay-since exists for
// demos and fixture capture". Default OFF: a session with no prior checkpoint bootstraps at EOF,
// never replaying a fixture's (or a real transcript's) full history on process start.
const REPLAY_FROM_START = process.env.REPLAY_FROM_START === 'true';
// Deliberately independent of every <HARNESS>_HOME/OPENCODE_DB_PATH above: this process's own
// checkpoint file must never live inside a directory any adapter watches (guard test:
// `checkpoint-path.test.ts`).
const CHECKPOINT_FILE = join(process.cwd(), '.data', 'checkpoints.json');
// design.md "Launch <-> log correlation": CLAIM_POST_WINDOW_MS is 30s, so a 1s tick expires a
// timed-out claim within one second of its window closing without a tight busy-poll.
const LAUNCH_CORRELATION_TICK_MS = 1000;
// design.md "Session discovery and aging out": IDLE_TIMEOUT_MS/EVICT_TIMEOUT_MS are 10/60 minutes,
// so a 30s tick is frequent enough that no session lingers long past either boundary.
const SESSION_LIFECYCLE_TICK_MS = 30_000;

/** `<HARNESS>_ENABLED=false` opts a harness out; any other value (including unset) keeps it on. */
function isHarnessEnabled(envVar: string): boolean {
  return process.env[envVar] !== 'false';
}

function createIdAllocator(): () => number {
  let next = 1;
  return () => next++;
}

/**
 * `allocateId` is ONE allocator shared by every source (and by `subagentCorrelator`). Each source
 * class otherwise defaults to its own counter starting at 1, which makes ids collide across
 * harnesses — and `ring-buffer.ts`'s `planReplay` resumes with `e.id > lastEventId`, so colliding
 * ids silently drop another harness's unseen events on reconnect. Pinned by
 * `event-id-allocator.test.ts`.
 */
function buildSources(
  subagentCorrelator: ClaudeCodeSubagentCorrelationCoordinator,
  allocateId: () => number,
  clock: { now: () => number },
): ActivitySource[] {
  const sources: ActivitySource[] = [];
  if (isHarnessEnabled('CLAUDE_CODE_ENABLED')) {
    // Shared with `subagentCorrelator` (same instance, built in `main()`) so a `parent` event and
    // this session's own tail-derived events never collide on `id`.
    sources.push(
      new ClaudeCodeActivitySource(CLAUDE_HOME, {
        allocateId,
        now: clock.now,
        replayFromStart: REPLAY_FROM_START,
        // Edge 2 (spec: "MUST correlate ... using toolUseResult.agentId"): fed straight from the
        // parsed PARENT-transcript record, alongside (never instead of) edge 1 below.
        onParentRecord: (parentSessionKey, record) => subagentCorrelator.offerParentRecord(parentSessionKey, record),
      }),
    );
  }
  if (isHarnessEnabled('CODEX_ENABLED')) {
    sources.push(new CodexActivitySource(CODEX_HOME, { allocateId, now: clock.now, replayFromStart: REPLAY_FROM_START }));
  }
  if (isHarnessEnabled('ANTIGRAVITY_ENABLED')) {
    sources.push(new AntigravityActivitySource(GEMINI_HOME, { allocateId, now: clock.now, replayFromStart: REPLAY_FROM_START }));
  }
  if (isHarnessEnabled('OPENCODE_ENABLED')) sources.push(new OpenCodeActivitySource(OPENCODE_DB_PATH, { allocateId }));
  return sources;
}

async function main(): Promise<void> {
  const hub = new SseEventHub();
  const checkpointStore = new FileCheckpointStore(CHECKPOINT_FILE);
  const clock = { now: () => Date.now() };
  // Session idle-out and eviction (design.md "Session discovery and aging out"): observes every
  // event any ingestion adapter publishes so it can age each session on the injected clock, and
  // publishes the domain's own synthetic `session_end(reason: 'timeout')` straight to `hub` (never
  // back through `trackedPublisher`, so its own eviction never re-enters `observe`) once a session
  // stops writing for `EVICT_TIMEOUT_MS`.
  const lifecycleCoordinator = new SessionLifecycleCoordinator(hub, clock);
  const trackedPublisher: EventPublisher = {
    publish: (event) => {
      lifecycleCoordinator.observe(event);
      hub.publish(event);
    },
  };
  // Claude Code subagent lanes (design.md "Correlation and the Agent Tree"): wires the two
  // independent, already-tested `correlate.ts` edges into the live bus, matching the shape of the
  // launch correlator below. Claude-code-only — the other three harnesses derive `parent` events
  // their own way (e.g. OpenCode's `session.parent_id`, mapped directly in its own `parse.ts`).
  const claudeCodeAllocateId = createIdAllocator();
  const subagentCorrelator = new ClaudeCodeSubagentCorrelationCoordinator(trackedPublisher, clock, claudeCodeAllocateId);
  const sources = buildSources(subagentCorrelator, claudeCodeAllocateId, clock);
  // Subsystem Separation from Ingestion (spec: agent-launcher): the launcher shares the bus
  // (`hub` as `EventPublisher`) but no code path with any of the four adapters above. The
  // correlator itself lives entirely inside the launcher subsystem too — this composition root is
  // the ONLY place that connects it to the ingestion adapters' `discover()` output, exactly as
  // design.md's "Subsystem Separation from Ingestion" requires (no adapter-to-adapter import).
  const correlator = new LaunchCorrelationCoordinator({ publisher: hub, clock });
  const launcher = new CorrelatingSessionLauncher(
    new ChildProcessSessionLauncher({ publisher: hub, terminalBackend: createNodePtyProbe() }),
    correlator,
    clock,
  );

  for (const source of sources) {
    void ingestAgentActivity({
      source,
      publisher: trackedPublisher,
      checkpointStore,
      onSessionDiscovered: (session) => {
        correlator.offerCandidate(session);
        // Edge 1 (directory-name edge): only claude-code sessions carry `isSubagent`/
        // `parentSessionKey` (`discover.ts`'s classifier); every other harness's `SessionRef` is
        // structurally compatible but semantically a no-op for `offerSession` since it never sets
        // `isSubagent`.
        if (source.harness === 'claude-code') {
          const claudeCodeSession = session as ClaudeCodeSessionRef;
          subagentCorrelator.offerSession(claudeCodeSession);
          // Agent profile tracking (fix: "profiles under DEFAULT settings" — profiles are state,
          // not history): a one-time, read-only, fire-and-forget scan of this parent's already-
          // written transcript, run alongside (never blocking) the live tail. A slow or failing
          // scan degrades profiles only, matching the try/catch precedent above.
          void scanAndApplyAgentProfiles(subagentCorrelator, claudeCodeSession);
        }
      },
    }).catch((error: unknown) => {
      console.error(`[office-agent-visualizer] ${source.harness} ingestion stopped unexpectedly:`, error);
    });
  }

  const correlationTimer = setInterval(() => correlator.expireTimedOutClaims(), LAUNCH_CORRELATION_TICK_MS);
  const lifecycleTimer = setInterval(() => lifecycleCoordinator.tick(), SESSION_LIFECYCLE_TICK_MS);

  const server = createStreamServer(hub, launcher);
  server.listen(PORT, HOST, () => {
    console.log(`[office-agent-visualizer] SSE stream ready at http://${HOST}:${PORT}/stream`);
    for (const source of sources) {
      console.log(`[office-agent-visualizer] watching ${source.harness} (read-only)`);
    }
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(correlationTimer);
    clearInterval(lifecycleTimer);
    server.close();
    await Promise.all(sources.map((source) => source.close()));
    await launcher.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
