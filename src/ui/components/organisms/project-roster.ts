/**
 * Project roster organism — the readable answer to "which projects and agents are actually live
 * right now", which a floor of near-identical desks cannot give at a glance once more than a
 * handful of sessions are on stage.
 *
 * Pure and canvas-free, like every other organism here: it folds one row per project out of the
 * view model's `roster`, and `ui/main.ts` turns those rows into DOM.
 *
 * It reads `roster`, never `workers`: the floor only has `MAX_PACKED_WORKERS` (8) desks and
 * everything past that is reduced to a bare `overflowCount`, so a roster built from the drawn
 * workers would report 8 agents on a machine running 17 — exactly the under-reporting this panel
 * exists to prevent.
 *
 * Nothing here decides WHO is active — that is the session lifecycle's job
 * (`domain/sessions/session-lifecycle.ts` ages a quiet session to idle and evicts it entirely once
 * it stops writing for good). This module only reports what the office state already says.
 */
import { resolveProjectSegment } from '../atoms/agent-tooltip';
import { resolveCharacterId, type CharacterId } from '../../scene/character/character-sprite';
import type { OfficeRosterEntry } from '../../state/office-view-model';

export interface ProjectRosterRow {
  /** Final path segment of the project's working directory, or `Unknown`. */
  project: string;
  /** The character every worker of this project is drawn as (`resolveCharacterId`). */
  character: CharacterId;
  /** Sessions currently producing events. */
  working: number;
  /** Sessions still on stage but past the idle threshold. */
  idle: number;
  orchestrators: number;
  subagents: number;
}

export interface ProjectRosterView {
  rows: ProjectRosterRow[];
  totalProjects: number;
  totalAgents: number;
}

/**
 * Groups by the RESOLVED project segment rather than the raw path, so the roster's rows match the
 * tooltip's own Project row exactly — two different absolute paths ending in the same directory
 * name would otherwise be one row here and two different labels there.
 */
export function buildProjectRoster(workers: OfficeRosterEntry[]): ProjectRosterView {
  const byProject = new Map<string, ProjectRosterRow>();

  for (const worker of workers) {
    const project = resolveProjectSegment(worker.projectPath);
    const row = byProject.get(project) ?? {
      project,
      character: resolveCharacterId(worker.projectPath),
      working: 0,
      idle: 0,
      orchestrators: 0,
      subagents: 0,
    };

    // A worker whose activity the view model never set is NOT counted as working: the renderer
    // degrades a missing activity to idle too (`animation-state.ts`), and the roster must never
    // claim more live agents than the office is actually drawing as live.
    if (worker.activity === 'working') row.working += 1;
    else row.idle += 1;

    if (worker.role === 'orchestrator') row.orchestrators += 1;
    else row.subagents += 1;

    byProject.set(project, row);
  }

  // Busiest project first, ties broken alphabetically so the panel never reorders itself between
  // two frames that carry the same counts.
  const rows = [...byProject.values()].sort((a, b) => {
    const byWorking = b.working - a.working;
    if (byWorking !== 0) return byWorking;
    const byTotal = b.working + b.idle - (a.working + a.idle);
    if (byTotal !== 0) return byTotal;
    return a.project.localeCompare(b.project);
  });

  return { rows, totalProjects: rows.length, totalAgents: workers.length };
}
