import type { Unsubscribe } from './workspace-port.js';

/** A single language-server diagnostic. Lines and columns are 1-based. */
export interface Diagnostic {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly severity: 'error' | 'warning' | 'information' | 'hint';
  readonly message: string;
  /** Diagnostic producer, e.g. `'ts'` or `'eslint'`; absent when the server omits it. */
  readonly source?: string;
}

/**
 * Language diagnostics from whatever language servers the user already has
 * installed (Docs/TARS_SPEC.md §3.2, §7.2). TARS ships no parsers of its own.
 */
export interface DiagnosticsPort {
  /** All diagnostics, or only those for `path` when given. */
  all(path?: string): readonly Diagnostic[];

  onDidChange(listener: (paths: readonly string[]) => void): Unsubscribe;
}
