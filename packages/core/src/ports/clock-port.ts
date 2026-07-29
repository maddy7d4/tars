/**
 * Injected time (Docs/TARS_SPEC.md §3.2). Not over-abstraction: checkpoints,
 * session logs and usage records are all timestamped, and asserting on them
 * against a real clock produces flaky ordering tests. A deterministic counter in
 * tests makes those assertions exact.
 */
export interface ClockPort {
  /** Milliseconds since epoch. */
  now(): number;

  /** ISO-8601 timestamp, for log records read by humans. */
  nowIso(): string;

  /** Resolves after `ms`; fake implementations advance instantly. */
  sleep(ms: number): Promise<void>;
}
