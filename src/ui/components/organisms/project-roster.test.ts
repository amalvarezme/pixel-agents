import { describe, expect, it } from 'vitest';
import { buildProjectRoster } from './project-roster';
import { CHARACTER_IDS, resolveCharacterId } from '../../scene/character/character-sprite';
import type { OfficeRosterEntry } from '../../state/office-view-model';

function worker(overrides: Partial<OfficeRosterEntry> = {}): OfficeRosterEntry {
  return { sessionKey: `claude-code:${Math.random()}`, harness: 'claude-code', ...overrides };
}

describe('buildProjectRoster', () => {
  it('reports nothing for an empty office', () => {
    expect(buildProjectRoster([])).toEqual({ rows: [], totalProjects: 0, totalAgents: 0 });
  });

  it('groups every worker of one project into a single row', () => {
    const view = buildProjectRoster([
      worker({ projectPath: '/a/pixel-agents', activity: 'working' }),
      worker({ projectPath: '/a/pixel-agents', activity: 'working' }),
    ]);

    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ project: 'pixel-agents', working: 2, idle: 0 });
    expect(view.totalAgents).toBe(2);
  });

  it('separates working from idle sessions', () => {
    const view = buildProjectRoster([
      worker({ projectPath: '/a/pixel-agents', activity: 'working' }),
      worker({ projectPath: '/a/pixel-agents', activity: 'idle' }),
    ]);

    expect(view.rows[0]).toMatchObject({ working: 1, idle: 1 });
  });

  it('counts a worker with no reported activity as idle, never as working', () => {
    // The renderer degrades a missing activity to idle too; the roster must not claim more live
    // agents than the office actually draws as live.
    const view = buildProjectRoster([worker({ projectPath: '/a/pixel-agents' })]);

    expect(view.rows[0]).toMatchObject({ working: 0, idle: 1 });
  });

  it('counts orchestrators and subagents separately', () => {
    const view = buildProjectRoster([
      worker({ projectPath: '/a/p', role: 'orchestrator' }),
      worker({ projectPath: '/a/p', role: 'subagent' }),
      worker({ projectPath: '/a/p', role: 'subagent' }),
    ]);

    expect(view.rows[0]).toMatchObject({ orchestrators: 1, subagents: 2 });
  });

  it('counts a worker with no reported role as a subagent, matching how the scene draws it', () => {
    const view = buildProjectRoster([worker({ projectPath: '/a/p' })]);

    expect(view.rows[0]).toMatchObject({ orchestrators: 0, subagents: 1 });
  });

  it('labels a worker with no project the same way the tooltip does', () => {
    const view = buildProjectRoster([worker({})]);

    expect(view.rows[0]?.project).toBe('Unknown');
  });

  it('groups by the resolved segment, so the roster and the tooltip always agree', () => {
    const view = buildProjectRoster([
      worker({ projectPath: '/one/pixel-agents' }),
      worker({ projectPath: '/two/pixel-agents/' }),
    ]);

    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.project).toBe('pixel-agents');
  });

  /**
   * 11.6 adversarial twin (the PRE-FIX symptom). A Pi subagent's registry header names a project,
   * never a path, so before it inherits the orchestrator's path it arrives with NO `projectPath`
   * and the roster files it under `Unknown` — a phantom SECOND project for one real checkout, the
   * live `2 PROJECTS · 4 AGENTS` reading. This test documents that symptom; the companion below is
   * the post-fix half, where the inherited path collapses the two into one row.
   */
  it('counts an unattributed subagent as its own project — the phantom second project the fix removes (11.6 adversarial twin)', () => {
    const view = buildProjectRoster([
      worker({ projectPath: '/a/pixel-agents', role: 'orchestrator', activity: 'working' }),
      worker({ role: 'subagent', activity: 'working' }),
    ]);

    expect(view.totalProjects).toBe(2);
    expect(view.totalAgents).toBe(2);
    expect(view.rows.map((row) => row.project)).toContain('Unknown');
  });

  it('collapses an orchestrator and its path-inheriting subagent into ONE project, never a phantom second (11.6)', () => {
    const view = buildProjectRoster([
      worker({ projectPath: '/a/pixel-agents', role: 'orchestrator', activity: 'working' }),
      worker({ projectPath: '/a/pixel-agents', role: 'subagent', activity: 'working' }),
    ]);

    expect(view.rows).toHaveLength(1);
    expect(view.totalProjects).toBe(1);
    expect(view.totalAgents).toBe(2);
    expect(view.rows[0]).toMatchObject({ project: 'pixel-agents', orchestrators: 1, subagents: 1, working: 2 });
  });

  it('carries the character the scene draws that project as', () => {
    // Two assertions, because the name makes two claims. The first is "the roster never surfaces an
    // id outside the shipped set" (a literal list here went stale the moment a fifth character
    // shipped), and the second is the stronger one the name actually promises: the roster resolves
    // the SAME character the scene draws for that project, from the same hash, so a project can
    // never wear one face on the floor and another in the roster.
    const view = buildProjectRoster([worker({ projectPath: '/a/pixel-agents' })]);

    expect(CHARACTER_IDS).toContain(view.rows[0]?.character);
    expect(view.rows[0]?.character).toBe(resolveCharacterId('/a/pixel-agents'));
  });

  it('puts the busiest project first', () => {
    const view = buildProjectRoster([
      worker({ projectPath: '/a/quiet', activity: 'idle' }),
      worker({ projectPath: '/a/busy', activity: 'working' }),
      worker({ projectPath: '/a/busy', activity: 'working' }),
    ]);

    expect(view.rows.map((r) => r.project)).toEqual(['busy', 'quiet']);
  });

  it('breaks ties alphabetically so the panel never reshuffles between identical frames', () => {
    const view = buildProjectRoster([
      worker({ projectPath: '/a/zeta', activity: 'working' }),
      worker({ projectPath: '/a/alpha', activity: 'working' }),
    ]);

    expect(view.rows.map((r) => r.project)).toEqual(['alpha', 'zeta']);
  });
});
