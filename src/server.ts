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
 * Wires three of the four harnesses (Claude Code, Codex, Antigravity) READ-ONLY through their own
 * `ActivitySource`; OpenCode's SQLite-polling `ActivitySource` is a separate, not-yet-composed
 * work unit (tasks.md B.1). The only path this process ever writes to is its OWN checkpoint file
 * under `.data/`, entirely outside every watched tree, shared safely across harnesses because
 * every `sessionKey` this process ever mints is already prefixed with its harness id.
 *
 * Each source is independently disableable via `<HARNESS>_ENABLED=false` (tasks.md rollback
 * boundary: "disable each adapter independently via config"). A harness whose root does not exist
 * on this machine degrades quietly rather than crashing the process: `discoverCodexSessions`/
 * `discoverAntigravitySessions` already treat a missing root as "no sessions" (ENOENT -> `[]`),
 * so ingestion for that harness simply never finds anything to open.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActivitySource } from './ports/activity-source.port';
import { AntigravityActivitySource } from './adapters/driven/antigravity/activity-source';
import { ClaudeCodeActivitySource } from './adapters/driven/claude-code/activity-source';
import { CodexActivitySource } from './adapters/driven/codex/activity-source';
import { FileCheckpointStore } from './adapters/driven/checkpoint/file-checkpoint-store';
import { createStreamServer, SseEventHub } from './adapters/driving/http/stream';
import { ingestAgentActivity } from './application/ingest-agent-activity/ingest-agent-activity';

const PORT = Number(process.env.PORT ?? 4317);
const HOST = '127.0.0.1';
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? join(homedir(), '.claude');
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const GEMINI_HOME = process.env.GEMINI_HOME ?? join(homedir(), '.gemini');
const CHECKPOINT_FILE = join(process.cwd(), '.data', 'checkpoints.json');

/** `<HARNESS>_ENABLED=false` opts a harness out; any other value (including unset) keeps it on. */
function isHarnessEnabled(envVar: string): boolean {
  return process.env[envVar] !== 'false';
}

function buildSources(): ActivitySource[] {
  const sources: ActivitySource[] = [];
  if (isHarnessEnabled('CLAUDE_CODE_ENABLED')) sources.push(new ClaudeCodeActivitySource(CLAUDE_HOME));
  if (isHarnessEnabled('CODEX_ENABLED')) sources.push(new CodexActivitySource(CODEX_HOME));
  if (isHarnessEnabled('ANTIGRAVITY_ENABLED')) sources.push(new AntigravityActivitySource(GEMINI_HOME));
  return sources;
}

async function main(): Promise<void> {
  const hub = new SseEventHub();
  const checkpointStore = new FileCheckpointStore(CHECKPOINT_FILE);
  const sources = buildSources();

  for (const source of sources) {
    void ingestAgentActivity({ source, publisher: hub, checkpointStore }).catch((error: unknown) => {
      console.error(`[office-agent-visualizer] ${source.harness} ingestion stopped unexpectedly:`, error);
    });
  }

  const server = createStreamServer(hub);
  server.listen(PORT, HOST, () => {
    console.log(`[office-agent-visualizer] SSE stream ready at http://${HOST}:${PORT}/stream`);
    for (const source of sources) {
      console.log(`[office-agent-visualizer] watching ${source.harness} (read-only)`);
    }
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await Promise.all(sources.map((source) => source.close()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
