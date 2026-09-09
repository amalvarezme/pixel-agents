/**
 * Composition-level guard: every `ActivitySource` in `server.ts` must share ONE event-id
 * allocator.
 *
 * Each source class defaults to its own counter starting at 1, so composing several harnesses
 * without passing a shared allocator makes their ids collide — reproduced live against the real
 * server with three harnesses enabled: `id=1` was simultaneously `claude-code/session_start`,
 * `codex/session_start` and `antigravity/session_start`.
 *
 * That is not cosmetic. `ring-buffer.ts`'s `planReplay` resumes with `events.filter(e => e.id >
 * lastEventId)`, so a client reconnecting with `Last-Event-ID: 3` silently drops every event with
 * a lower id from every OTHER harness — including ones it has never seen. The ring buffer exists
 * precisely to make reconnect lossless.
 *
 * `server.ts` calls `void main()` at import time, so this test scans its source text rather than
 * importing it, following the precedent set by `checkpoint-path.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_SOURCE = readFileSync(join(import.meta.dirname, 'server.ts'), 'utf8');

describe('server.ts event-id allocation', () => {
  it('constructs every ActivitySource with an explicit allocateId', () => {
    const constructions = SERVER_SOURCE.match(/new \w*ActivitySource\(/g) ?? [];
    expect(constructions.length).toBeGreaterThanOrEqual(4); // all four harnesses are composed

    // Each construction's argument list must mention `allocateId`. Scanning per-construction
    // rather than counting file-wide occurrences means adding a fifth harness without the shared
    // allocator fails here instead of passing on the strength of the other four.
    const withoutAllocator = constructions.filter((ctor) => {
      const start = SERVER_SOURCE.indexOf(ctor) + ctor.length;
      let depth = 1;
      let i = start;
      while (depth > 0 && i < SERVER_SOURCE.length) {
        if (SERVER_SOURCE[i] === '(') depth++;
        else if (SERVER_SOURCE[i] === ')') depth--;
        i++;
      }
      return !SERVER_SOURCE.slice(start, i).includes('allocateId');
    });

    expect(withoutAllocator).toEqual([]);
  });

  it('adversarial near-miss: the scan is per-construction, not a file-wide keyword check', () => {
    // If the guard merely asked "does server.ts mention allocateId anywhere", a file with one
    // wired source and three unwired ones would pass. Prove the scan rejects exactly that shape.
    const fixture = `
      new ClaudeCodeActivitySource(HOME, { allocateId: shared });
      new CodexActivitySource(HOME);
    `;
    const constructions = fixture.match(/new \w*ActivitySource\(/g) ?? [];
    const missing = constructions.filter((ctor) => {
      const start = fixture.indexOf(ctor) + ctor.length;
      let depth = 1;
      let i = start;
      while (depth > 0 && i < fixture.length) {
        if (fixture[i] === '(') depth++;
        else if (fixture[i] === ')') depth--;
        i++;
      }
      return !fixture.slice(start, i).includes('allocateId');
    });

    expect(missing).toHaveLength(1);
    expect(fixture).toContain('allocateId'); // the naive file-wide check would have passed
  });
});
