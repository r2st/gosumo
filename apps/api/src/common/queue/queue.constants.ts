/**
 * How long a single job attempt may run before Bull fails it, in ms.
 *
 * Deliberately generous. The purpose is not to enforce a latency budget —
 * outbound HTTP is already bounded by `fetchWithTimeout`, which is where a
 * slow provider is caught. This is the backstop for the failure mode nothing
 * else covers: a handler that hangs on something with no deadline of its own
 * (a stuck database call, a promise that is never settled). Such a job never
 * fails, so it never retries; it simply holds its concurrency slot until the
 * process is restarted, and the queue loses throughput with nothing in the
 * logs to say why.
 *
 * Five minutes sits well above the slowest legitimate job here — the nightly
 * retention sweep and the analytics rollups are the long ones, and both batch.
 * Anything running longer than this in a worker is a problem to surface, not
 * one to keep waiting on.
 */
export const JOB_TIMEOUT_MS = 5 * 60 * 1000;
