import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../domain/events/types';
import { ClaudeCodeActivitySource } from './activity-source';
import { scanAndApplyAgentProfiles, scanLatestModelForSession, scanParentTranscriptForAgentProfiles } from './agent-profile-scan';
import type { ClaudeCodeSessionRef } from './discover';
import { ClaudeCodeSubagentCorrelationCoordinator } from './subagent-correlation-coordinator';

function launchLine(toolUseId: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }] },
  });
}

function assistantModelLine(model: string, text = 'hi'): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text }] } });
}

function resultLine(toolUseId: string, agentId: string): string {
  return JSON.stringify({
    type: 'user',
    toolUseResult: { agentId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
  });
}

function makeCoordinator(): { coordinator: ClaudeCodeSubagentCorrelationCoordinator; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn<(event: AgentEvent) => void>();
  const coordinator = new ClaudeCodeSubagentCorrelationCoordinator({ publish }, { now: () => 1000 });
  return { coordinator, publish };
}

function parentRef(overrides: Partial<ClaudeCodeSessionRef> = {}): ClaudeCodeSessionRef {
  return {
    harness: 'claude-code',
    sessionKey: 'claude-code:parent-1',
    filePath: '/tmp/does-not-exist/parent-1.jsonl',
    isSubagent: false,
    parentSessionKey: null,
    cwd: null,
    discoveredAt: 0,
    ...overrides,
  };
}

describe('scanParentTranscriptForAgentProfiles', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('resolves agentType/requestedModel/task for a launch fully written to disk', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-profile-scan-'));
    const filePath = join(dir, 'parent-1.jsonl');
    await writeFile(
      filePath,
      `${launchLine('toolu_1', { subagent_type: 'sdd-apply', model: 'sonnet', description: 'Apply slice' })}\n${resultLine('toolu_1', 'agent-one')}\n`,
    );

    const resolved = await scanParentTranscriptForAgentProfiles(filePath);

    expect(resolved).toEqual([
      {
        childSessionKey: 'claude-code:agent-one',
        claim: { toolUseId: 'toolu_1', agentType: 'sdd-apply', model: 'sonnet', task: 'Apply slice' },
      },
    ]);
  });

  // Sizing fact: `Agent` launches sit anywhere from 4% to 98% through a real transcript. A tiny
  // `maxChunkBytes` here forces many bounded reads, proving a late launch is still found rather
  // than silently missed by a scan that only looked at the first chunk.
  it('finds a launch positioned near the END of a large multi-chunk file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-profile-scan-late-'));
    const filePath = join(dir, 'parent-1.jsonl');
    const padding = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"x"}}]}}\n'.repeat(300);
    await writeFile(
      filePath,
      `${padding}${launchLine('toolu_late', { subagent_type: 'jd-judge-a', description: 'Judge' })}\n${resultLine('toolu_late', 'agent-late')}\n`,
    );

    const resolved = await scanParentTranscriptForAgentProfiles(filePath, { maxChunkBytes: 64 });

    expect(resolved).toEqual([
      { childSessionKey: 'claude-code:agent-late', claim: { toolUseId: 'toolu_late', agentType: 'jd-judge-a', task: 'Judge' } },
    ]);
  });

  it('returns nothing for a transcript with no Agent launch', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-profile-scan-none-'));
    const filePath = join(dir, 'parent-1.jsonl');
    await writeFile(filePath, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}\n');

    const resolved = await scanParentTranscriptForAgentProfiles(filePath);

    expect(resolved).toEqual([]);
  });

  it('never publishes anything itself — it only returns extracted facts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-profile-scan-pure-'));
    const filePath = join(dir, 'parent-1.jsonl');
    await writeFile(filePath, `${launchLine('toolu_1', { subagent_type: 'sdd-apply' })}\n${resultLine('toolu_1', 'agent-one')}\n`);
    const publish = vi.fn();

    const resolved = await scanParentTranscriptForAgentProfiles(filePath);

    expect(resolved).toHaveLength(1); // real extraction happened
    expect(publish).not.toHaveBeenCalled(); // yet nothing was ever wired to a publisher
  });
});

// Agent profile tracking, live-model recovery (fix: "the resolved model is 1 of 21" — EOF
// bootstrap means the live tail never reads a session's pre-existing history for its own model).
describe('scanLatestModelForSession', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('resolves the LATEST real message.model in a session transcript, bounded to the tail', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-model-scan-'));
    const filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, `${assistantModelLine('claude-sonnet-5')}\n`);

    const model = await scanLatestModelForSession(filePath);

    expect(model).toBe('claude-sonnet-5');
  });

  // Discriminating: run with a small maxChunkBytes (forces several bounded backward reads) and a
  // model that appears only NEAR THE START, with many later lines carrying no model at all — a
  // naive "read only the last chunk" implementation would silently return undefined here.
  it('finds a model positioned near the START of a large multi-chunk transcript', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-model-scan-early-'));
    const filePath = join(dir, 'session.jsonl');
    const noise = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"x"}}]}}\n'.repeat(300);
    await writeFile(filePath, `${assistantModelLine('claude-opus-5')}\n${noise}`);

    const model = await scanLatestModelForSession(filePath, { maxChunkBytes: 64 });

    expect(model).toBe('claude-opus-5');
  });

  it('resolves to the LATER model when the model changes mid-transcript', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-model-scan-later-'));
    const filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, `${assistantModelLine('claude-opus-5')}\n${assistantModelLine('claude-sonnet-5')}\n`);

    const model = await scanLatestModelForSession(filePath);

    expect(model).toBe('claude-sonnet-5');
  });

  // The `<synthetic>` sentinel is never a real model (Claude Code emits it on some system-
  // generated records, interleaved with real ones) — the LAST real value before it must win.
  it('resolves to the real value BEFORE a trailing <synthetic> sentinel record, not the sentinel itself', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-model-scan-sentinel-'));
    const filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, `${assistantModelLine('claude-opus-5')}\n${assistantModelLine('<synthetic>')}\n`);

    const model = await scanLatestModelForSession(filePath);

    expect(model).toBe('claude-opus-5');
  });

  it('returns undefined for a transcript that never records a real model', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-model-scan-none-'));
    const filePath = join(dir, 'session.jsonl');
    await writeFile(filePath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');

    const model = await scanLatestModelForSession(filePath);

    expect(model).toBeUndefined();
  });
});

describe('scanAndApplyAgentProfiles', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('applies a resolved profile onto the coordinator (healthy scan populates)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-profile-apply-'));
    const filePath = join(dir, 'parent-1.jsonl');
    await writeFile(filePath, `${launchLine('toolu_1', { subagent_type: 'sdd-apply', model: 'sonnet', description: 'Apply' })}\n${resultLine('toolu_1', 'agent-one')}\n`);
    const { coordinator, publish } = makeCoordinator();

    await scanAndApplyAgentProfiles(coordinator, parentRef({ filePath }));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      sessionKey: 'claude-code:agent-one',
      agentProfile: { role: 'subagent', agentType: 'sdd-apply', requestedModel: 'sonnet', task: 'Apply' },
    });
  });

  // Adversarial twin of the test above: same shape, but the file does not exist, so the scan
  // rejects. Ingestion (and discovery of other sessions) must never be broken by that failure.
  it('degrades silently when the scan fails — a missing/unreadable transcript never throws', async () => {
    const { coordinator, publish } = makeCoordinator();

    await expect(scanAndApplyAgentProfiles(coordinator, parentRef({ filePath: '/tmp/definitely-missing-dir/parent-1.jsonl' }))).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  // The Agent-launch scan specifically stays a no-op for a subagent (a profile's agentType/
  // requestedModel/task live in its PARENT transcript, never its own) — but this fixture also
  // carries no message.model, so the (now session-agnostic) live-model scan finds nothing either.
  it('is a no-op for a SUBAGENT session with no message.model — a launch profile lives in its PARENT transcript, never its own', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-profile-apply-subagent-'));
    const filePath = join(dir, 'agent-one.jsonl');
    // Even though this file itself contains an Agent launch shape, it must never be scanned as a
    // parent transcript when isSubagent is true.
    await writeFile(filePath, `${launchLine('toolu_1', { subagent_type: 'sdd-apply' })}\n${resultLine('toolu_1', 'agent-two')}\n`);
    const { coordinator, publish } = makeCoordinator();

    await scanAndApplyAgentProfiles(coordinator, parentRef({ filePath, isSubagent: true, sessionKey: 'claude-code:agent-one', parentSessionKey: 'claude-code:parent-1' }));

    expect(publish).not.toHaveBeenCalled();
  });

  // The primary regression this work unit fixes: a SUBAGENT's resolved model lives ONLY in its
  // OWN transcript (never its parent's) — the Agent-launch scan above can never see it, so the
  // discovery-time scan must read the subagent's own file too.
  it('applies the RESOLVED model for a SUBAGENT session, read from its OWN transcript', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-profile-apply-subagent-model-'));
    const filePath = join(dir, 'agent-one.jsonl');
    await writeFile(filePath, `${assistantModelLine('claude-sonnet-5')}\n`);
    const { coordinator, publish } = makeCoordinator();

    await scanAndApplyAgentProfiles(coordinator, parentRef({ filePath, isSubagent: true, sessionKey: 'claude-code:agent-one', parentSessionKey: 'claude-code:parent-1' }));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      sessionKey: 'claude-code:agent-one',
      agentProfile: { role: 'subagent', model: 'claude-sonnet-5' },
    });
  });

  it('applies the RESOLVED model for an ORCHESTRATOR (parent) session, alongside its launch scan', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-code-profile-apply-orchestrator-model-'));
    const filePath = join(dir, 'parent-1.jsonl');
    await writeFile(filePath, `${assistantModelLine('claude-opus-5')}\n`);
    const { coordinator, publish } = makeCoordinator();

    await scanAndApplyAgentProfiles(coordinator, parentRef({ filePath }));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      sessionKey: 'claude-code:parent-1',
      agentProfile: { role: 'orchestrator', model: 'claude-opus-5' },
    });
  });
});

describe('agent profile scan integration: profiles populate WITHOUT replay', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('recovers a subagent profile from history that the EOF-bootstrapped live tail alone misses', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-profile-e2e-'));
    const projectDir = join(root, 'projects', 'my-slug');
    await mkdir(projectDir, { recursive: true });
    const parentFilePath = join(projectDir, 'parent-1.jsonl');
    await writeFile(parentFilePath, `${launchLine('toolu_1', { subagent_type: 'sdd-apply', model: 'sonnet', description: 'Apply' })}\n${resultLine('toolu_1', 'agent-one')}\n`);

    const { coordinator, publish } = makeCoordinator();

    // Baseline: the LIVE path, bootstrapped at EOF (default — no replayFromStart), never reads
    // this pre-existing history — proving the bug this scan fixes actually exists.
    const source = new ClaudeCodeActivitySource(root, {
      onParentRecord: (key, record) => coordinator.offerParentRecord(key, record),
    });
    const discoverIterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await discoverIterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();
    const first = await streamIterator.next();
    expect(first.value?.event.kind).toBe('session_start');
    stream.stop();
    await source.close();
    expect(publish).not.toHaveBeenCalled();

    // Act: the discovery-time scan recovers the profile from the same on-disk history.
    await scanAndApplyAgentProfiles(coordinator, sessionRef as ClaudeCodeSessionRef);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      sessionKey: 'claude-code:agent-one',
      agentProfile: { role: 'subagent', agentType: 'sdd-apply', requestedModel: 'sonnet', task: 'Apply' },
    });
  });

  // Discriminating test (guard quality): this runs with REPLAY OFF (the default, EOF-bootstrapped
  // live tail). With replay on, the live tail's own bootstrap read already resolves the model —
  // proving nothing about THIS fix. Here the live tail reads nothing at all, so a resolved model
  // can only have come from the discovery-time scan.
  it('recovers a session\'s OWN resolved model from history that the EOF-bootstrapped live tail alone misses', async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-code-model-e2e-'));
    const projectDir = join(root, 'projects', 'my-slug');
    await mkdir(projectDir, { recursive: true });
    const sessionFilePath = join(projectDir, 'parent-1.jsonl');
    await writeFile(sessionFilePath, `${assistantModelLine('claude-sonnet-5')}\n`);

    const { coordinator, publish } = makeCoordinator();

    const source = new ClaudeCodeActivitySource(root, {
      onParentRecord: (key, record) => coordinator.offerParentRecord(key, record),
    });
    const discoverIterator = source.discover()[Symbol.asyncIterator]();
    const { value: sessionRef } = await discoverIterator.next();
    const stream = source.open(sessionRef!, null);
    const streamIterator = stream.events[Symbol.asyncIterator]();
    const first = await streamIterator.next();
    expect(first.value?.event.kind).toBe('session_start');
    expect(first.value?.event.agentProfile?.model).toBeUndefined();
    stream.stop();
    await source.close();
    expect(publish).not.toHaveBeenCalled();

    await scanAndApplyAgentProfiles(coordinator, sessionRef as ClaudeCodeSessionRef);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      sessionKey: (sessionRef as ClaudeCodeSessionRef).sessionKey,
      agentProfile: { role: 'orchestrator', model: 'claude-sonnet-5' },
    });
  });
});
