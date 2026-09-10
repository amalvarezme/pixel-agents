/**
 * Agent profile — what a worker IS (design.md-equivalent: "Agent profile tracking"). Framework-
 * free and entirely optional so a harness that reports none of it still works: every field here
 * is optional except `role`, and a `Worker`/`AgentEventBase` with no `agentProfile` at all keeps
 * working exactly as before this concept existed.
 *
 * `role` distinguishes the orchestrator (a root session, never itself launched by an `Agent` tool
 * call) from a subagent (launched by one). `agentType`/`model`/`task` are all optional and MUST
 * NEVER be defaulted or invented when the source data does not carry them (spec: "a missing model
 * stays absent rather than defaulting").
 *
 * Purely structural (type export only, no logic): triangulation skipped, there is nothing to
 * exercise beyond the type declaration itself.
 */
export type AgentRole = 'orchestrator' | 'subagent';

export interface AgentProfile {
  role: AgentRole;
  /** The named subagent type (e.g. `sdd-apply`), known only for a `role: 'subagent'` worker,
   * resolved from the launching `Agent` tool_use's `subagent_type` input. */
  agentType?: string;
  /**
   * The RESOLVED, LIVE model actually running this worker (e.g. `claude-sonnet-5`), observed from
   * the worker's own transcript and updated as it changes — a session can switch model mid-run
   * (a `/model` command, a fast-mode toggle), for the orchestrator and for a subagent alike, so
   * this is never captured once and frozen. Absent until the worker's own transcript has reported
   * a real value; never defaulted or backfilled from `requestedModel`.
   */
  model?: string;
  /**
   * The model a subagent was LAUNCHED WITH, straight from the `Agent` tool_use's own `model`
   * input — an alias (`sonnet`/`opus`/`haiku`), or absent meaning "the default". This is a
   * REQUEST, not the running model: it is never displayed as, or used to fill in, `model` above.
   */
  requestedModel?: string;
  /** The short task the worker was given (resolved from the launch's `description` input for a
   * subagent), shown as the caption detail. */
  task?: string;
}
