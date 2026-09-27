import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  presenceActivityFileName,
  presenceHeaderFileName,
  readPresenceActivity,
  readPresenceHeaders,
  type PresenceHeader,
  type PresenceTaskSummary,
} from './presence-read';

const SESSION_HASH = 'a'.repeat(64);
const INCARNATION = '5f6ea6c5-4745-45b1-b5bc-c9e442172deb';

const summary = (over: Partial<PresenceTaskSummary> = {}): PresenceTaskSummary => ({
  id: 't1',
  agent: 'sdd-apply',
  label: 'apply work unit 2',
  status: 'running',
  model: 'claude-sonnet-5',
  createdAt: 1_000,
  startedAt: 1_100,
  endedAt: null,
  lastActivityAt: 1_200,
  ...over,
});

const activityBody = (tasks: unknown[], generation = 1) =>
  JSON.stringify({
    schema: 1,
    sessionHash: SESSION_HASH,
    incarnation: INCARNATION,
    generation,
    activity: { tasks },
  });

const header = (over: Partial<PresenceHeader> = {}): PresenceHeader => ({
  schema: 1,
  sessionHash: SESSION_HASH,
  incarnation: INCARNATION,
  label: 'pixel-agents',
  heartbeat: 1_200,
  generation: 1,
  counts: { running: 1, queued: 0, waiting: 0, finished: 0 },
  digest: null,
  unavailable: null,
  ...over,
});

describe('presence registry reader', () => {
  let root: string;

  /** Writes one valid header/activity pair, with the digest the header must carry to be trusted. */
  async function writeActivation(
    tasks: unknown[] = [{ summary: summary(), thread: { version: 1, dropped: 0, items: [] } }],
    over: Partial<PresenceHeader> = {},
    generation = 1,
  ): Promise<string> {
    const body = activityBody(tasks, generation);
    await writeFile(join(root, presenceActivityFileName(SESSION_HASH, INCARNATION)), body);
    const digest = createHash('sha256').update(body).digest('hex');
    const value = header({ digest, generation, ...over });
    await writeFile(join(root, presenceHeaderFileName(SESSION_HASH, INCARNATION)), JSON.stringify(value));
    return body;
  }

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  describe('readPresenceHeaders', () => {
    it('returns no entries and stays healthy when the presence directory does not exist', async () => {
      root = join(await mkdtemp(join(tmpdir(), 'pi-presence-absent-')), 'presence');

      const page = await readPresenceHeaders(root, 0);

      expect(page.entries).toEqual([]);
      expect(page.unavailable).toBe('missing');
    });

    it('reads a valid header and marks a fresh heartbeat as recent', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-'));
      await writeActivation();

      const page = await readPresenceHeaders(root, 1_200 + 5_000);

      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]).toMatchObject({ sessionHash: SESSION_HASH, label: 'pixel-agents', recent: true });
    });

    // gentle-pi's own reader treats a heartbeat older than 15s as not recent.
    it('marks a heartbeat older than the 15s TTL as not recent', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-stale-'));
      await writeActivation();

      const page = await readPresenceHeaders(root, 1_200 + 15_001);

      expect(page.entries[0]?.recent).toBe(false);
    });

    it('skips a header whose filename disagrees with its own sessionHash/incarnation', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-misnamed-'));
      await writeFile(join(root, presenceHeaderFileName('b'.repeat(64), INCARNATION)), JSON.stringify(header()));

      const page = await readPresenceHeaders(root, 1_200);

      expect(page.entries).toEqual([]);
      expect(page.rejected).toBe(1);
    });

    it('skips a structurally invalid header without throwing', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-invalid-'));
      await writeFile(
        join(root, presenceHeaderFileName(SESSION_HASH, INCARNATION)),
        JSON.stringify({ ...header(), counts: { running: 'many', queued: 0, waiting: 0, finished: 0 } }),
      );

      const page = await readPresenceHeaders(root, 1_200);

      expect(page.entries).toEqual([]);
      expect(page.rejected).toBe(1);
    });

    it('skips malformed JSON without throwing', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-malformed-'));
      await writeFile(join(root, presenceHeaderFileName(SESSION_HASH, INCARNATION)), '{not json');

      const page = await readPresenceHeaders(root, 1_200);

      expect(page.entries).toEqual([]);
      expect(page.rejected).toBe(1);
    });

    it('ignores files that are not headers, including dotfile temporaries', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-nonheader-'));
      await writeActivation();
      await writeFile(join(root, `.${presenceHeaderFileName(SESSION_HASH, INCARNATION)}.tmp`), '{}');
      await writeFile(join(root, 'README.txt'), 'not a header');

      const page = await readPresenceHeaders(root, 1_200);

      expect(page.entries).toHaveLength(1);
      expect(page.rejected).toBe(0);
    });

    /**
     * Both link tests deliberately point at a header whose CONTENT is perfectly valid, so the only
     * possible reason to reject it is the link itself. With an invalid body they would pass even
     * with the guards removed, proving nothing.
     */
    async function writeValidHeaderBody(path: string): Promise<void> {
      const body = activityBody([]);
      await writeFile(join(root, presenceActivityFileName(SESSION_HASH, INCARNATION)), body);
      await writeFile(path, JSON.stringify(header({ digest: createHash('sha256').update(body).digest('hex') })));
    }

    it('rejects a symlinked header rather than following it', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-symlink-'));
      const real = join(root, 'real.json');
      await writeValidHeaderBody(real);
      await symlink(real, join(root, presenceHeaderFileName(SESSION_HASH, INCARNATION)));

      const page = await readPresenceHeaders(root, 1_200);

      expect(page.entries).toEqual([]);
      expect(page.rejected).toBe(1);
    });

    it('rejects a hard-linked header, whose content another path can still change', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-hardlink-'));
      const real = join(root, 'other.json');
      await writeValidHeaderBody(real);
      await link(real, join(root, presenceHeaderFileName(SESSION_HASH, INCARNATION)));

      const page = await readPresenceHeaders(root, 1_200);

      expect(page.entries).toEqual([]);
      expect(page.rejected).toBe(1);
    });

    it('rejects a header larger than the 16 KiB bound', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-oversized-'));
      const padded = { ...header(), label: 'x'.repeat(20 * 1024) };
      await writeFile(join(root, presenceHeaderFileName(SESSION_HASH, INCARNATION)), JSON.stringify(padded));

      const page = await readPresenceHeaders(root, 1_200);

      expect(page.entries).toEqual([]);
      expect(page.rejected).toBe(1);
    });
  });

  describe('readPresenceActivity', () => {
    it('reads the activity whose digest and generation the header vouches for', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-activity-'));
      await writeActivation();
      const page = await readPresenceHeaders(root, 1_200);

      const result = await readPresenceActivity(root, page.entries[0]!);

      expect(result.activity?.tasks[0]?.summary).toEqual(summary());
      expect(result.unavailable).toBeUndefined();
    });

    it('reports digest-mismatch when the activity no longer matches its header', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-digest-'));
      await writeActivation();
      const page = await readPresenceHeaders(root, 1_200);
      await writeFile(join(root, presenceActivityFileName(SESSION_HASH, INCARNATION)), activityBody([]));

      const result = await readPresenceActivity(root, page.entries[0]!);

      expect(result.activity).toBeUndefined();
      expect(result.unavailable).toBe('digest-mismatch');
    });

    it('reports generation-mismatch when the activity is from another publication', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-generation-'));
      const body = activityBody([], 7);
      await writeFile(join(root, presenceActivityFileName(SESSION_HASH, INCARNATION)), body);
      await writeFile(
        join(root, presenceHeaderFileName(SESSION_HASH, INCARNATION)),
        JSON.stringify(header({ generation: 1, digest: createHash('sha256').update(body).digest('hex') })),
      );
      const page = await readPresenceHeaders(root, 1_200);

      const result = await readPresenceActivity(root, page.entries[0]!);

      expect(result.unavailable).toBe('generation-mismatch');
    });

    it('never opens the activity file when the header already declares it too large', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-toolarge-'));
      await writeFile(
        join(root, presenceHeaderFileName(SESSION_HASH, INCARNATION)),
        JSON.stringify(header({ digest: null, unavailable: 'activity-too-large' })),
      );
      const page = await readPresenceHeaders(root, 1_200);

      const result = await readPresenceActivity(root, page.entries[0]!);

      expect(result.activity).toBeUndefined();
      expect(result.unavailable).toBe('activity-too-large');
    });

    it('reports missing when the activity file is absent', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-noactivity-'));
      await writeActivation();
      const page = await readPresenceHeaders(root, 1_200);
      await rm(join(root, presenceActivityFileName(SESSION_HASH, INCARNATION)));

      expect((await readPresenceActivity(root, page.entries[0]!)).unavailable).toBe('missing');
    });

    it('rejects an activity file replaced between the stat and the open', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-replaced-'));
      await writeActivation();
      const page = await readPresenceHeaders(root, 1_200);
      const activityPath = join(root, presenceActivityFileName(SESSION_HASH, INCARNATION));

      const result = await readPresenceActivity(root, page.entries[0]!, {
        // Test-only seam: reproduces Pi's own atomic rename landing between our two syscalls.
        afterStat: async () => {
          await rm(activityPath);
          await writeFile(activityPath, activityBody([]));
        },
      });

      expect(result.activity).toBeUndefined();
      expect(result.unavailable).toBe('unsafe-file');
    });

    it('rejects a task row whose summary is structurally invalid, publishing none of the activation', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-badtask-'));
      await writeActivation([{ summary: { ...summary(), status: 'daydreaming' }, thread: { version: 1, dropped: 0, items: [] } }]);
      const page = await readPresenceHeaders(root, 1_200);

      expect((await readPresenceActivity(root, page.entries[0]!)).unavailable).toBe('malformed');
    });

    it('reads thread items, keeping tool items with their running and error flags', async () => {
      root = await mkdtemp(join(tmpdir(), 'pi-presence-thread-'));
      await writeActivation([
        {
          summary: summary(),
          thread: {
            version: 3,
            dropped: 0,
            items: [
              { kind: 'thinking', text: 'considering' },
              { kind: 'tool', callId: 'c1', name: 'bash', output: 'ok', running: false, isError: true },
            ],
          },
        },
      ]);
      const page = await readPresenceHeaders(root, 1_200);

      const thread = (await readPresenceActivity(root, page.entries[0]!)).activity?.tasks[0]?.thread;

      expect(thread?.version).toBe(3);
      expect(thread?.items[1]).toEqual({ kind: 'tool', callId: 'c1', name: 'bash', output: 'ok', running: false, isError: true });
    });
  });
});
