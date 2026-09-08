/**
 * `POST /launch` (tasks.md 26.1, design.md D2: "Launch is `POST /launch`, not a socket frame").
 * Parses a JSON `LaunchSpec` body, delegates to `launchAgentSession`, and reports the outcome as
 * an HTTP status: `started`/`unavailable_interactive` -> 200 (the request was handled, whether or
 * not a process ended up running), `failed` -> 502 (the launcher itself reports failure), a
 * malformed body -> 400 without ever reaching the use case.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { launchAgentSession } from '../../../application/launch-agent-session/launch-agent-session';
import { HARNESS_IDS } from '../../../domain/events/types';
import type { LaunchSpec, SessionLauncher } from '../../../ports/session-launcher.port';

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseLaunchSpec(rawBody: string): LaunchSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { harness, cwd, args, interactive } = parsed as Record<string, unknown>;
  if (typeof harness !== 'string' || !(HARNESS_IDS as readonly string[]).includes(harness)) return null;
  if (typeof cwd !== 'string') return null;
  if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))) return null;
  if (interactive !== undefined && typeof interactive !== 'boolean') return null;
  return { harness: harness as LaunchSpec['harness'], cwd, args: (args as string[] | undefined) ?? [], interactive };
}

function respondJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleLaunchRequest(req: IncomingMessage, res: ServerResponse, launcher: SessionLauncher): Promise<void> {
  const rawBody = await readRequestBody(req);
  const spec = parseLaunchSpec(rawBody);
  if (!spec) {
    respondJson(res, 400, { error: 'invalid launch request body' });
    return;
  }

  const result = await launchAgentSession(launcher, spec);
  respondJson(res, result.outcome === 'failed' ? 502 : 200, result);
}
