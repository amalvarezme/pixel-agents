/**
 * OpenCode `memory_write` detector (tasks.md 18.2-18.5; spec: "OpenCode memory_write Detection").
 * Fixtures are synthetic `part` rows built from the confirmed real schema/tool-naming in
 * `research-local-evidence.md` Q3 — `test/fixtures/opencode/*.json`.
 *
 * False-positive trap (tasks.md 18.3): OpenCode uses BARE `<server>_<tool>` naming with no
 * `mcp__` prefix, so a similarly-shaped-but-different-server tool (`context7_query-docs`) MUST
 * NOT fire. The trap fixture is otherwise IDENTICAL in shape to the true positive (`type:"tool"`,
 * nested `state.input`, same session) — only the `tool` name differs — so a passing test here
 * cannot be explained by any other structural difference.
 */
import { describe, expect, it } from 'vitest';
import contextTrapFixture from '../../../../test/fixtures/opencode/context7-false-positive-part.json';
import memSaveFixture from '../../../../test/fixtures/opencode/mem-save-part.json';
import { OpenCodeMemoryWriteDetector } from './memory-write-detector';
import type { OpenCodePartRow } from './parse';

interface OpenCodePartFixture {
  id: string;
  message_id: string;
  session_id: string;
  data: unknown;
}

function toPartRow(fixture: OpenCodePartFixture): OpenCodePartRow {
  return {
    id: fixture.id,
    message_id: fixture.message_id,
    session_id: fixture.session_id,
    data: JSON.stringify(fixture.data),
  };
}

describe('OpenCodeMemoryWriteDetector (tasks.md 18.5)', () => {
  const detector = new OpenCodeMemoryWriteDetector();

  it('emits a memory_write signal for an engram_mem_save part row (true positive)', () => {
    const signal = detector.detect(toPartRow(memSaveFixture));

    expect(signal).not.toBeNull();
    expect(signal?.toolLabel).toBe('engram_mem_save');
    expect(signal?.title).toBe('Synthetic fixture: verified OpenCode Engram wiring');
    expect(signal?.observationType).toBe('discovery');
  });

  it('does NOT fire for context7_query-docs — a bare <server>_<tool> name that merely looks similar (false-positive trap)', () => {
    const signal = detector.detect(toPartRow(contextTrapFixture));

    expect(signal).toBeNull();
  });

  it('does not match on type alone — a non-"tool" part with tool-shaped data still does not fire', () => {
    const row: OpenCodePartRow = {
      id: 'prt_x',
      message_id: 'msg_x',
      session_id: 'ses_x',
      data: JSON.stringify({ type: 'text', tool: 'engram_mem_save' }),
    };

    expect(detector.detect(row)).toBeNull();
  });

  it('malformed JSON in data never throws, just does not fire', () => {
    const row: OpenCodePartRow = { id: 'prt_bad', message_id: 'msg_bad', session_id: 'ses_bad', data: '{not json' };

    expect(() => detector.detect(row)).not.toThrow();
    expect(detector.detect(row)).toBeNull();
  });

  it('reports its harness as opencode (Detector Interface Isolation)', () => {
    expect(detector.harness).toBe('opencode');
  });
});
