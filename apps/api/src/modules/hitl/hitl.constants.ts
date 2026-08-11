/**
 * Shared constants for the HITL module.
 */

/**
 * How many overdue tasks a single SLA sweep claims.
 * Each row is hydrated with {@link HitlRepository.taskIncludes} — conversation,
 * assignee, resolver, parent and child tasks — so an unbounded read would pull
 * an arbitrary number of joined rows into one tick. A backlog (a worker outage,
 * a clock jump) drains across sweeps instead. Oldest-due first, so the tasks
 * that have been breached longest are always flagged first.
 */
export const OVERDUE_TASK_SWEEP_BATCH_SIZE = 200;
