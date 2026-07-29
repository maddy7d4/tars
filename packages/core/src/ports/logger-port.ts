/** Severity levels, ordered so a threshold comparison is meaningful. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured logging into a VS Code output channel
 * (Docs/TARS_SPEC.md §3.2). `fields` is a flat record rather than free text so
 * the same record can later be forwarded somewhere machine-readable without
 * reparsing prose.
 */
export interface LoggerPort {
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void;

  /**
   * A logger tagged with a subsystem name. Returned rather than requiring every
   * call site to repeat the tag, which drifts.
   */
  child(name: string): LoggerPort;
}
