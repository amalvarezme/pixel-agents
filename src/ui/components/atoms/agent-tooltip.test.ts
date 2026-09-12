import { describe, expect, it } from 'vitest';
import { buildAgentTooltip, resolveProjectSegment, type AgentTooltipSource } from './agent-tooltip';

function source(overrides: Partial<AgentTooltipSource> = {}): AgentTooltipSource {
  return { harnessName: 'Claude Code', ...overrides };
}

function rowMap(source: AgentTooltipSource): Record<string, string> {
  const tooltip = buildAgentTooltip(source);
  return Object.fromEntries(tooltip.rows.map((row) => [row.label, row.value]));
}

describe('buildAgentTooltip (atom) — pure DOM-tooltip content builder, no DOM, no PixiJS', () => {
  it('always produces exactly five rows, in order: Project, Agent, Role, Model, Task', () => {
    const tooltip = buildAgentTooltip(source());

    expect(tooltip.rows).toHaveLength(5);
    expect(tooltip.rows.map((r) => r.label)).toEqual(['Project', 'Agent', 'Role', 'Model', 'Task']);
  });

  describe('Project row', () => {
    it('renders the final path segment of projectPath, not the full path', () => {
      expect(rowMap(source({ projectPath: '/Users/andresalvarez/Documents/pixel-agents' })).Project).toBe(
        'pixel-agents',
      );
    });

    it('is "Unknown" when projectPath is absent', () => {
      expect(rowMap(source()).Project).toBe('Unknown');
    });

    it('is "Unknown" when projectPath is blank', () => {
      expect(rowMap(source({ projectPath: '   ' })).Project).toBe('Unknown');
    });

    it('is the FIRST row, before Agent', () => {
      const tooltip = buildAgentTooltip(source({ projectPath: '/a/b/pixel-agents' }));
      expect(tooltip.rows[0]).toEqual({ label: 'Project', value: 'pixel-agents' });
    });
  });

  describe('Agent row', () => {
    it('is the given full harness name', () => {
      expect(rowMap(source({ harnessName: 'Codex' })).Agent).toBe('Codex');
    });
  });

  describe('Role row', () => {
    it('is "Orchestrator" for role=orchestrator', () => {
      expect(rowMap(source({ role: 'orchestrator' })).Role).toBe('Orchestrator');
    });

    it('is "Subagent (<agentType>)" for a subagent with a known agentType', () => {
      expect(rowMap(source({ role: 'subagent', agentType: 'sdd-apply' })).Role).toBe('Subagent (sdd-apply)');
    });

    it('is plain "Subagent" for a subagent with no known agentType', () => {
      expect(rowMap(source({ role: 'subagent' })).Role).toBe('Subagent');
    });

    it('is "Unknown" when there is no profile at all (role absent)', () => {
      expect(rowMap(source()).Role).toBe('Unknown');
    });

    // Adversarial twin: orchestrator role ignores agentType even if present.
    it('ignores agentType for an orchestrator', () => {
      expect(rowMap(source({ role: 'orchestrator', agentType: 'sdd-apply' })).Role).toBe('Orchestrator');
    });
  });

  describe('Model row — resolved-live vs requested-only contract', () => {
    it('shows the live model alone when only model is known', () => {
      expect(rowMap(source({ model: 'claude-sonnet-5' })).Model).toBe('claude-sonnet-5');
    });

    it('shows the requested model EXPLICITLY marked as a request when only requestedModel is known', () => {
      expect(rowMap(source({ requestedModel: 'opus' })).Model).toBe('unknown (requested: opus)');
    });

    it('shows both when model and requestedModel are known and DIFFER', () => {
      expect(rowMap(source({ model: 'claude-sonnet-5', requestedModel: 'opus' })).Model).toBe(
        'claude-sonnet-5 (requested: opus)',
      );
    });

    it('shows the model alone when model and requestedModel are known and MATCH', () => {
      expect(rowMap(source({ model: 'opus', requestedModel: 'opus' })).Model).toBe('opus');
    });

    it('is "Unknown" when neither model nor requestedModel is known', () => {
      expect(rowMap(source()).Model).toBe('Unknown');
    });

    // Adversarial twin: requestedModel must NEVER silently become the displayed running model —
    // it must always carry the "(requested: ...)" marker, never appear bare in the Model row.
    it('never renders requestedModel as if it were the running model', () => {
      const value = rowMap(source({ requestedModel: 'haiku' })).Model;
      expect(value).toContain('requested: haiku');
      expect(value).not.toBe('haiku');
    });
  });

  describe('Task row — fallback chain: task > tool caption > "No task reported"', () => {
    it('uses task when present, even if a tool caption is also present', () => {
      expect(
        rowMap(source({ task: 'Refactoring auth module', toolLabel: 'Read', toolDetail: 'design.md' })).Task,
      ).toBe('Refactoring auth module');
    });

    it('falls back to "toolLabel: toolDetail" when task is absent', () => {
      expect(rowMap(source({ toolLabel: 'Read', toolDetail: 'design.md' })).Task).toBe('Read: design.md');
    });

    it('falls back to toolLabel alone when toolDetail is absent', () => {
      expect(rowMap(source({ toolLabel: 'Read' })).Task).toBe('Read');
    });

    // Defect fix: the chain used to end at the worker's `label`, but `office.ts` falls back to
    // `sessionKey` for the label, so a profile-less worker printed a raw `claude-code:<uuid>`
    // under "Task". A session identity is not a task — say "No task reported" instead.
    it('reports no task when task and toolLabel are both absent, never the session label', () => {
      expect(rowMap(source({})).Task).toBe('No task reported');
    });

    it('reports no task when task and tool caption are both blank', () => {
      expect(rowMap(source({ task: '', toolLabel: '' })).Task).toBe('No task reported');
    });

    // Adversarial twin: a blank task string must not win over a real tool caption.
    it('treats a blank task as absent and falls through to the tool caption', () => {
      expect(rowMap(source({ task: '', toolLabel: 'Read', toolDetail: 'x' })).Task).toBe('Read: x');
    });

    // Adversarial twin: a blank toolLabel must not be rendered as an empty Task row.
    it('treats a blank toolLabel as absent and falls through to "No task reported"', () => {
      expect(rowMap(source({ toolLabel: '' })).Task).toBe('No task reported');
    });

    it('caps a pathologically long task at ~120 chars with an ellipsis, unlike the desk caption budget', () => {
      const longTask = 'x'.repeat(500);
      const value = rowMap(source({ task: longTask })).Task!;

      expect(value.length).toBeLessThanOrEqual(120);
      expect(value.endsWith('…')).toBe(true);
    });

    it('does not truncate a task that already fits comfortably under the caption budget', () => {
      // The on-canvas caption budget (CAPTION_MAX_CHARS) is much smaller than 120 chars; this
      // value would be truncated as a desk caption but must render whole in the DOM tooltip.
      const mediumTask = 'a'.repeat(80);
      expect(rowMap(source({ task: mediumTask })).Task).toBe(mediumTask);
    });
  });
});

describe('resolveProjectSegment (pure helper, no node:path — runs in the browser)', () => {
  it('renders the final segment of a POSIX absolute path', () => {
    expect(resolveProjectSegment('/Users/andresalvarez/Documents/pixel-agents')).toBe('pixel-agents');
  });

  it('handles a trailing slash', () => {
    expect(resolveProjectSegment('/a/b/')).toBe('b');
  });

  it('is "Unknown" for the filesystem root — there is no project name', () => {
    expect(resolveProjectSegment('/')).toBe('Unknown');
  });

  it('returns a single bare segment unchanged', () => {
    expect(resolveProjectSegment('pixel-agents')).toBe('pixel-agents');
  });

  it('is "Unknown" for an empty string', () => {
    expect(resolveProjectSegment('')).toBe('Unknown');
  });

  it('is "Unknown" for a blank (whitespace-only) string', () => {
    expect(resolveProjectSegment('   ')).toBe('Unknown');
  });

  it('is "Unknown" when projectPath is absent (undefined)', () => {
    expect(resolveProjectSegment(undefined)).toBe('Unknown');
  });

  it('handles a Windows-style path', () => {
    expect(resolveProjectSegment('C:\\dev\\my-app')).toBe('my-app');
  });

  // Adversarial twin: a Windows-style path with a trailing backslash must not yield an empty
  // segment either — same rule as the POSIX trailing-slash case above.
  it('handles a Windows-style path with a trailing backslash', () => {
    expect(resolveProjectSegment('C:\\dev\\my-app\\')).toBe('my-app');
  });

  // Adversarial twin: consecutive duplicate separators must collapse, never producing an empty
  // "ghost" segment that wins over the real last one.
  it('collapses consecutive duplicate separators', () => {
    expect(resolveProjectSegment('/a/b//')).toBe('b');
  });

  // Adversarial twin: mixed POSIX/Windows separators in the same path must still resolve to the
  // true final segment.
  it('handles mixed / and \\ separators in the same path', () => {
    expect(resolveProjectSegment('/a\\b/c')).toBe('c');
  });
});

/**
 * Character pack guide section 20: portraits belong in panels, profiles and tooltips, never as a
 * sprite inside the scene. The face shown here must be the same character the floor draws, which
 * is why both resolve it from `projectPath` through `resolveCharacterId`.
 */
describe('buildAgentTooltip portrait', () => {
  it('points at the portrait of the character the scene draws for that project', () => {
    const view = buildAgentTooltip({ harnessName: 'Claude Code', projectPath: '/Users/me/pixel-agents' });

    expect(view.portraitUrl).toMatch(/^\/characters\/(alex|marcus|sophia|elena)\/\1_portrait\.png$/);
  });

  it('gives every worker of one project the same portrait, orchestrator and subagent alike', () => {
    const orchestrator = buildAgentTooltip({ harnessName: 'Claude Code', role: 'orchestrator', projectPath: '/a/p' });
    const subagent = buildAgentTooltip({ harnessName: 'Claude Code', role: 'subagent', projectPath: '/a/p' });

    expect(orchestrator.portraitUrl).toBe(subagent.portraitUrl);
  });

  it('still resolves a portrait for a worker whose harness reports no project', () => {
    const view = buildAgentTooltip({ harnessName: 'Antigravity' });

    expect(view.portraitUrl).toContain('_portrait.png');
  });
});
